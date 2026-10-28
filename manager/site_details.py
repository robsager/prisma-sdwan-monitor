"""Site details: one site's circuits with live latency, jitter, loss and utilization.

Each circuit of an open site is kept as a rolling 24 h of 1-minute points per metric. Opening a site
fetches 24 h (or, with recent saved history, nothing until the first live update); each live update
tops up the last few minutes. Only sites someone has open cost API calls, and a site whose IONs
are all offline costs none until one reconnects.

Calls per live update: 2 per 10 circuits for bandwidth (download and upload), plus 2 per circuit
for link quality, made only for circuits missing the newest minute (quiet circuits at most once
per STALE_RECHECK_S, circuits with no quality data at all per EMPTY_RECHECK_S). Quality metrics take
one circuit per query (live: 400 METRIC_SUPPORTS_SINGLE_PATH_ID for two or more). A data center
costs none: there's no circuit data at a data center, so its circuits aren't asked for at all.
"""
import threading
import time
from datetime import datetime, timedelta, timezone

from . import config
from .api.client import ApiError
from .api.pacing import pool
from .config import V
from .persist import SeriesDB
from .sdwan.devices import devices_by_site
from .sdwan.metrics import DIRECTIONS, LQM_QUERIES, bandwidth_points, lqm_points
from .sdwan.stats import LQM_KEYS, circuit_metrics
from .timeutil import minute_floor, minute_iso, minute_of, num, now_iso


class UnknownSite(Exception):
    pass


def _minutes(td: timedelta) -> int:
    return int(td.total_seconds()) // config.STEP_SECONDS


def _safe(fn, *args):
    try:
        return fn(*args), None
    except ApiError as e:
        return None, str(e)


class SeriesStore:
    """Circuits' series in memory ({wid: {key: {minute: value}}}), the end of each circuit's last
    complete fetch, and their copy in data/cache.db."""

    def __init__(self, tsg_id, db: SeriesDB):
        self.tsg_id = tsg_id
        self.db = db
        self._lock = threading.Lock()
        self._series = {}
        self._fetched = {}       # wid -> epoch minute up to which bandwidth and quality were fetched
        self._lqm_checked = {}   # wid -> time.time() of its last quality query (quiet circuits)

    def load(self, wids):
        """Bring saved series into memory for circuits not there yet."""
        with self._lock:
            missing = [w for w in wids if w not in self._series]
        if not missing:
            return
        try:
            saved = self.db.load(self.tsg_id, missing)
        except Exception:  # noqa: BLE001 - the cache is optional
            saved = {}
        with self._lock:
            for wid in missing:
                fetched, series = saved.get(wid, (None, {}))
                if wid not in self._series:
                    self._series[wid] = series
                    if fetched is not None:
                        self._fetched.setdefault(wid, fetched)

    def merge(self, wid, key, points, cutoff):
        """Add (time, value) points; drop minutes before cutoff (epoch minute)."""
        with self._lock:
            series = self._series.setdefault(wid, {}).setdefault(key, {})
            series.update((minute_of(t), v) for t, v in points)
            for m in [m for m in series if m < cutoff]:
                del series[m]

    def mark_fetched(self, wid, start, end):
        """The circuit is complete up to end, if this fetch started at or before its last mark."""
        with self._lock:
            if start <= self._fetched.get(wid, start):
                self._fetched[wid] = end

    def fetched(self, wid):
        with self._lock:
            return self._fetched.get(wid)

    def lqm_latest(self, wid):
        with self._lock:
            times = [max(s) for k, s in self._series.get(wid, {}).items() if k in LQM_KEYS and s]
        return max(times) if times else None

    def lqm_checked(self, wid, now=None):
        """When the circuit's quality was last queried; with now, record a query at now."""
        with self._lock:
            if now is not None:
                self._lqm_checked[wid] = now
            return self._lqm_checked.get(wid, 0.0)

    def window(self, wid, since):
        """{key: sorted [(minute, value)]} from minute `since` on."""
        with self._lock:
            return {k: sorted((m, v) for m, v in s.items() if m >= since) for k, s in self._series.get(wid, {}).items()}

    def save(self, wids):
        with self._lock:
            rows = {w: (self._fetched.get(w), {k: dict(s) for k, s in self._series.get(w, {}).items()}) for w in wids}
        self.db.save(self.tsg_id, rows)

    def drop(self, wids):
        with self._lock:
            for w in wids:
                self._series.pop(w, None)
                self._lqm_checked.pop(w, None)
                self._fetched.pop(w, None)


class SiteDetails:
    """Site details for one tenant. svc is its TenantService (client and shared caches)."""

    def __init__(self, svc, db=None):
        self.svc = svc
        self.store = SeriesStore(svc.tsg_id, db or SeriesDB())
        self._lock = threading.Lock()
        self._open = {}          # site_id -> {"circuits": [waninterface], "used": t, "saved": t}
        self._evicted_at = time.time()

    # ---- the site and its circuits --------------------------------------------------------------

    def _site(self, site_id):
        site = next((s for s in self.svc.sites() if s["id"] == site_id), None)
        if site is None:
            raise UnknownSite(site_id)
        return site

    def _load_circuits(self, site_id):
        circuits = self.svc.client.get_items(f"/sdwan/{V.WANIF}/api/sites/{site_id}/waninterfaces")
        for w in circuits:
            w.setdefault("site_id", site_id)
        with self._lock:
            self._open[site_id] = {"circuits": circuits, "used": time.time(), "saved": time.time()}
        return circuits

    def _circuits(self, site_id):
        """The open site's circuits; registered again after an eviction or a restart (its series
        then come from data/cache.db, else the next update fetches 24 h)."""
        with self._lock:
            entry = self._open.get(site_id)
            if entry:
                entry["used"] = time.time()
                return entry["circuits"]
        self._site(site_id)
        return self._load_circuits(site_id)

    def _site_online(self, site_id):
        """True when an ION at the site is connected, None when the ION list failed to load."""
        try:
            elements = self.svc.elements()[1]
        except ApiError:
            return None
        return any(e.get("connected") for e in elements if e.get("site_id") == site_id)

    # ---- fetching -------------------------------------------------------------------------------

    def _resume_point(self, circuits, end):
        """Epoch minute to resume fetching from, when every circuit was fetched completely within
        INCREMENTAL_MAX_GAP (from memory or data/cache.db); else None (fetch 24 h)."""
        if not circuits:
            return None
        self.store.load([w["id"] for w in circuits])
        marks = [self.store.fetched(w["id"]) for w in circuits]
        if None in marks:
            return None
        resume = min(marks) - _minutes(config.RESUME_OVERLAP)
        return resume if end - resume < _minutes(config.INCREMENTAL_MAX_GAP) else None

    def _fetch(self, run, bw_circuits, lqm_circuits, start, end):
        """Fetch minutes [start, end) into the store -> {wid: [error, ...]}. run(fn, *args) runs fn
        concurrently (a thread pool's submit)."""
        start_dt, end_dt = (datetime.fromtimestamp(m * config.STEP_SECONDS, timezone.utc) for m in (start, end))
        batches = [bw_circuits[i:i + config.METRICS_BATCH] for i in range(0, len(bw_circuits), config.METRICS_BATCH)]
        bw_jobs = [(b, d, run(bandwidth_points, self.svc.client, b, d, start_dt, end_dt)) for b in batches for d in DIRECTIONS]
        lqm_jobs = [(w["id"], run(lqm_points, self.svc.client, w["site_id"], w["id"], q, start_dt, end_dt))
                    for w in lqm_circuits for q in LQM_QUERIES]
        cutoff = end - _minutes(config.HISTORY_WINDOW)
        errors = {}
        for batch, direction, fut in bw_jobs:
            points_by_wid, err = fut.result()
            key = f"bw_{DIRECTIONS[direction]}"
            for w in batch:
                if err:
                    errors.setdefault(w["id"], []).append(f"bandwidth {direction.lower()}: {err}")
                else:
                    self.store.merge(w["id"], key, points_by_wid.get(w["id"], []), cutoff)
        for wid, fut in lqm_jobs:
            points_by_key, err = fut.result()
            if err:
                errors.setdefault(wid, []).append(err)
            for key, points in points_by_key.items():
                self.store.merge(wid, key, points, cutoff)
        for w in lqm_circuits:
            if w["id"] not in errors:
                self.store.mark_fetched(w["id"], start, end)
        return errors

    def _save(self, site_id, force=False):
        """Save the site's series (at most every PERSIST_EVERY_S unless forced). False on failure."""
        with self._lock:
            entry = self._open.get(site_id)
            if not entry or (not force and time.time() - entry["saved"] < config.PERSIST_EVERY_S):
                return True
            entry["saved"] = time.time()
            wids = [w["id"] for w in entry["circuits"]]
        try:
            self.store.save(wids)
            return True
        except Exception:  # noqa: BLE001 - the cache is optional
            return False

    def _metrics(self, w, hours, end):
        capacity = {"bw_down": num(w.get("link_bw_down")), "bw_up": num(w.get("link_bw_up"))}
        return circuit_metrics(self.store.window(w["id"], end - hours * 60), capacity)

    # ---- pages ----------------------------------------------------------------------------------

    def detail(self, site_id, hours=24):
        """The site, its devices and its circuits with every metric's figures over the last `hours`."""
        site = self._site(site_id)
        hub = site.get("element_cluster_role") == "HUB"
        self._maybe_evict()
        self.svc.client.ensure_token()
        end = minute_of(minute_floor())
        with pool() as ex:
            f_nets = ex.submit(_safe, self.svc.wannetworks)
            f_labels = ex.submit(_safe, self.svc.wanlabels)
            f_elements = ex.submit(_safe, lambda: self.svc.elements()[1])
            circuits, circuits_error = ([], None) if hub else _safe(self._load_circuits, site_id)
            circuits = circuits or []
            resume = self._resume_point(circuits, end)
            elements, devices_error = f_elements.result()
            # A site without any ION has no data to fetch (live: 6 metrics calls for nothing).
            no_ions = elements is not None and not any(e.get("site_id") == site_id for e in elements)
            errors = {}
            if circuits and resume is None and not no_ions:
                errors = self._fetch(ex.submit, circuits, circuits, end - _minutes(config.HISTORY_WINDOW), end)
                now = time.time()
                for w in circuits:  # counts as their quality check: the first live update needn't repeat it
                    self.store.lqm_checked(w["id"], now)
                self._save(site_id, force=True)
            nets = {n["id"]: n for n in f_nets.result()[0] or []}
            labels = {lb["id"]: lb for lb in f_labels.result()[0] or []}

        rows = []
        for w in circuits:
            net = nets.get(w.get("network_id"), {})
            label = labels.get(w.get("label_id"), {})
            rows.append({
                "id": w["id"],
                "name": w.get("name") or net.get("name") or w["id"],
                "network": net.get("name"),
                "network_type": net.get("type") or w.get("type"),
                "label": label.get("name") or label.get("label"),
                "bw_down_mbps": num(w.get("link_bw_down")),
                "bw_up_mbps": num(w.get("link_bw_up")),
                "metrics": self._metrics(w, hours, end),
                "errors": errors.get(w["id"], []),
            })
        addr = site.get("address") or {}
        return {
            "tsg_id": self.svc.tsg_id,
            "generated_at": now_iso(),
            "end_time": minute_iso(end),
            "window_hours": hours,
            # Opened from saved data: current up to about here until the first live update.
            "saved_until": minute_iso(resume + _minutes(config.RESUME_OVERLAP)) if resume is not None else None,
            "site": {"id": site["id"], "name": site.get("name") or site["id"], "role": site.get("element_cluster_role"),
                     "admin_state": site.get("admin_state"), "city": addr.get("city"), "country": addr.get("country")},
            "devices": devices_by_site(elements or []).get(site_id, []),
            "devices_error": devices_error,
            "circuits": sorted(rows, key=lambda c: (c["name"] or "").lower()),
            "circuits_error": circuits_error,
        }

    def live(self, site_id, hours=24):
        """The open site's newest minutes, and every metric's figures over the last `hours` (sliced
        from the stored 24 h, so any period costs the same)."""
        top = self.svc.cache.get(("live", site_id), config.LIVE_CACHE_S, lambda: self._top_up(site_id))
        self._maybe_evict()
        end = top["end"]
        return {
            "generated_at": top["generated_at"],
            "end_time": minute_iso(end),
            "window_hours": hours,
            "offline": top["offline"],
            "circuits": {w["id"]: {"metrics": self._metrics(w, hours, end), "errors": top["errors"].get(w["id"], [])}
                         for w in top["circuits"]},
        }

    def _top_up(self, site_id):
        """Fetch the minutes the site's circuits are missing (none at a data center)."""
        end = minute_of(minute_floor())
        hub = self._site(site_id).get("element_cluster_role") == "HUB"
        circuits = [] if hub else self._circuits(site_id)
        result = {"generated_at": now_iso(), "end": end, "circuits": circuits, "errors": {}, "offline": False}
        if not circuits:
            return result
        # Every ION offline: no new data can exist. When one reconnects, the next update fetches
        # everything since the last fetch.
        if self._site_online(site_id) is False:
            result["offline"] = True
            return result

        self.store.load([w["id"] for w in circuits])
        newest = end - 1
        stale_before = end - _minutes(config.STALE_AFTER)
        now = time.time()
        lqm = []
        for w in circuits:
            last = self.store.lqm_latest(w["id"])
            if last is not None and last >= newest:
                continue  # already has the newest minute
            recheck = config.EMPTY_RECHECK_S if last is None else config.STALE_RECHECK_S
            if (last is None or last < stale_before) and now - self.store.lqm_checked(w["id"]) < recheck:
                continue  # quiet or offline circuit, checked recently
            self.store.lqm_checked(w["id"], now)
            lqm.append(w)

        # Normally the last few minutes; after opening from saved data, everything since then. A
        # circuit without a recent complete fetch (e.g. its quality queries keep failing) gets 24 h
        # on its own, so it doesn't make the others fetch 24 h on every update.
        overlap, gap = _minutes(config.RESUME_OVERLAP), _minutes(config.INCREMENTAL_MAX_GAP)
        marks = {w["id"]: self.store.fetched(w["id"]) for w in circuits}
        recent = {wid for wid, m in marks.items() if m is not None and end - (m - overlap) < gap}
        start = min([end - _minutes(config.LIVE_LOOKBACK)] + [marks[wid] - overlap for wid in recent])
        groups = [(start, [w for w in circuits if w["id"] in recent]),
                  (end - _minutes(config.HISTORY_WINDOW), [w for w in circuits if w["id"] not in recent])]
        with pool() as ex:
            for since, group in groups:
                if group:
                    ids = {w["id"] for w in group}
                    result["errors"].update(self._fetch(ex.submit, group, [w for w in lqm if w["id"] in ids], since, end))
        self._save(site_id)
        return result

    # ---- memory -----------------------------------------------------------------------------------

    def _maybe_evict(self):
        """Now and then (EVICT_CHECK_S), drop sites nobody has viewed for SITE_IDLE_S, in the
        background: their series are saved first, and kept if that fails."""
        with self._lock:
            if time.time() - self._evicted_at < config.EVICT_CHECK_S:
                return
            self._evicted_at = time.time()
        threading.Thread(target=self.evict_idle, daemon=True).start()

    def evict_idle(self, idle_s=None):
        cutoff = time.time() - (config.SITE_IDLE_S if idle_s is None else idle_s)
        with self._lock:
            idle = [sid for sid, e in self._open.items() if e["used"] < cutoff]
        for sid in idle:
            if not self._save(sid, force=True):
                continue  # try again later
            with self._lock:
                entry = self._open.get(sid)
                if entry is None or entry["used"] >= cutoff:
                    continue  # viewed again meanwhile
                del self._open[sid]
                in_use = {w["id"] for e in self._open.values() for w in e["circuits"]}
                self.store.drop([w["id"] for w in entry["circuits"] if w["id"] not in in_use])
            self.svc.cache.discard(("live", sid))
            self.svc.site_health.forget(sid)
            self.svc.top_apps.forget(sid)
            self.svc.probes.forget(sid)

    def open_sites(self):
        with self._lock:
            return list(self._open)

    def close(self):
        """Save every open site (tenant edited or deleted, or shutting down)."""
        for sid in self.open_sites():
            self._save(sid, force=True)
        self.store.db.close()

