"""The Overview's Health tile and Tenant panel: AIOps health and the tenant's applications.

Health: three monitor/aiops/health queries (sites, apps, links) over HEALTH_WINDOW, cached
HEALTH_CACHE_S while the Overview polls it. The fair and poor apps and links are named on the server:
apps from the cached app names Top applications uses, links from the topology Site details' alarms
use, so neither costs a call of its own most of the time.

Applications: every app across the Overview's sites over the last 24 h, the same counts as Top
applications summed over the sites (no RTT: that takes one query per app and site). One or two
applicationstats queries per TENANT_APPS_SITE_CHUNK sites with an ION, built on a background thread
and saved to data/cache.db: the last list shows at once (also after a restart) while a newer one
is built, every TENANT_APPS_CACHE_S while the panel is open.

One app's sites (clicking an app): the same counts per site for that app, from monitor/metrics (one
or two queries per METRICS_BATCH sites), kept in memory APP_SITES_CACHE_S.
"""
import sys
import threading
import time
import traceback
from datetime import timedelta

from . import config
from .api.cache import CacheError
from .api.client import ApiError
from .api.pacing import pool, set_background
from .sdwan import apps, health, overview, topology
from .timeutil import iso, minute_floor, now_iso


def _safe(fn, *args):
    try:
        return fn(*args), None
    except (ApiError, CacheError) as e:
        return None, str(e)


class TenantPanel:
    """Health and the tenant's applications for one tenant. svc is its TenantService."""

    def __init__(self, svc, clock=time.time):
        self.svc = svc
        self._clock = clock
        self._lock = threading.Lock()
        self._apps = {}   # exclude_dc -> {"result", "finished", "running", "error", "error_at"}
        self._by_app = {}  # (app_id, exclude_dc) -> the same, plus "progress": one app's sites

    # ---- AIOps health -----------------------------------------------------------------------------

    def health(self):
        """{generated_at, start, end, sites / apps / links: {id: category}, counts: {kind: {good,
        fair, poor, others, total} | None}, link_names, link_parts (topology.link_names), app_names
        (the fair and poor ones), errors}.
        A kind that failed has counts None; all three failing is an error."""
        return self.svc.cache.get("health", config.HEALTH_CACHE_S, self._health)

    def _health(self):
        end = minute_floor()
        start = end - config.HEALTH_WINDOW
        self.svc.client.ensure_token()
        with pool() as ex:
            futures = {kind: ex.submit(_safe, health.query, self.svc.client, kind, start, end) for kind in health.KINDS}
            out = {"generated_at": now_iso(), "start": iso(start), "end": iso(end), "counts": {}, "errors": []}
            for kind, fut in futures.items():
                resp, err = fut.result()
                if err:
                    out[kind], out["counts"][kind] = {}, None
                    out["errors"].append(f"{kind.capitalize()} health: {err}")
                else:
                    out[kind], out["counts"][kind] = health.parse(resp, kind)
        if len(out["errors"]) == len(health.KINDS):
            raise ApiError(out["errors"][0])
        flagged = lambda kind: {i for i, cat in out[kind].items() if cat in ("fair", "poor")}  # noqa: E731
        links, app_ids = flagged("links"), flagged("apps")
        names = self.svc.site_health.topology_names(links) if links else {}
        out["link_names"] = {i: n for i in links if (n := topology.tenant_name(names, i))}
        out["link_parts"] = {i: p for i in links if (p := topology.tenant_parts(names, i))}
        app_names = self.svc.top_apps.names() if app_ids else {}
        out["app_names"] = {i: app_names[i] for i in app_ids if i in app_names}
        return out

    def health_detail(self):
        """Health issues' details, asked for when its table is opened: {generated_at, start, end,
        slots: [5-minute interval starts], items: {kind: {id: {timeline, cause?}}}, limits, errors}.
        timeline: AIOps' category per slot (g / f / p, "-" not scored yet), for the fair and poor
        sites, apps and links. cause (links only): the Manager's estimate from the link's quality
        (health.link_cause), or None when not checked. Cached HEALTH_CACHE_S."""
        return self.svc.cache.get("health_detail", config.HEALTH_CACHE_S, self._health_detail)

    def _health_detail(self):
        summary = self.health()
        step = 300
        end = minute_floor()
        end -= timedelta(seconds=int(end.timestamp()) % step)
        start = end - config.HEALTH_WINDOW
        slots = [iso(start + timedelta(seconds=step * k)) for k in range(int(config.HEALTH_WINDOW.total_seconds()) // step)]
        flagged = {kind: [i for i, c in summary[kind].items() if c in ("fair", "poor")] for kind in health.KINDS}
        limits = {"loss": config.LINK_LOSS_FLAG_PCT, "latency_jump": config.LINK_LATENCY_JUMP_MS,
                  "jitter": config.LINK_JITTER_FLAG_MS, "mos": config.LINK_MOS_FLAG}
        out = {"generated_at": now_iso(), "start": iso(start), "end": iso(end), "slots": slots,
               "items": {kind: {} for kind in health.KINDS}, "limits": limits, "errors": []}
        kinds = [kind for kind in health.KINDS if flagged[kind]]
        with pool(workers=config.ENDPOINT_CONCURRENCY["aiops"]) as ex:
            futures = {kind: ex.submit(_safe, health.timeseries_query, self.svc.client, kind, start, end) for kind in kinds}
            cats = {}
            for kind, fut in futures.items():
                resp, err = fut.result()
                if err:
                    out["errors"].append(f"{kind.capitalize()} health intervals: {err}")
                cats[kind] = health.parse_timeseries(resp, kind) if resp else {}
        for kind in kinds:
            for oid in flagged[kind]:
                out["items"][kind][oid] = {"timeline": health.timeline(cats[kind].get(oid, {}), slots)}

        # Links: poor first, at most HEALTH_CAUSE_MAX_LINKS, each with a known site to query from.
        parts = summary.get("link_parts") or {}
        sites, _ = _safe(self.svc.sites)
        hubs = {s["id"] for s in sites or [] if s.get("element_cluster_role") == "HUB"}
        ends = {i: health.quality_end((parts.get(i) or {}).get("ends") or [], hubs) for i in flagged["links"]}
        links = sorted((i for i in flagged["links"] if ends[i]),
                       key=lambda i: summary["links"][i] != "poor")[:config.HEALTH_CAUSE_MAX_LINKS]

        def quality(link_id):
            end0 = ends[link_id]
            if end0["site_id"] in hubs:  # data center to data center: the API has no LQM from either end
                return {**health.link_cause({}, {}, None, limits), "note": "Data center to data center link: no link quality data from the API"}
            q, failed = {}, []
            for label, metrics, view in health.LINK_METRICS:
                body = health.link_quality_body(metrics, view, end0["site_id"], link_id, start, end)
                try:
                    health.parse_link_quality(self.svc.client.request(
                        "POST", f"/sdwan/monitor/{config.V.METRICS}/api/monitor/metrics", json=body), q)
                except ApiError as e:
                    failed.append(f"{label}: {e}")
            cause = health.link_cause(cats.get("links", {}).get(link_id, {}), q, end0.get("site"), limits)
            if failed:
                cause["note"] = "Link quality didn't load: " + "; ".join(failed)
            return cause

        with pool(workers=config.ENDPOINT_CONCURRENCY["metrics"]) as ex:
            for link_id, cause in zip(links, ex.map(quality, links)):
                out["items"]["links"][link_id]["cause"] = cause
        self._app_details(summary, flagged["apps"], cats.get("apps", {}), start, end, out)
        return out

    def _app_details(self, summary, app_ids, cats, start, end, out):
        """Adds aiops {score, sites: [{id, name, cat, counters}]} and cause {sites: [{name, ...
        health.app_cause}]} to the fair and poor apps' items."""
        apps_ = sorted(app_ids, key=lambda i: summary["apps"][i] != "poor")[:config.HEALTH_CAUSE_MAX_APPS]
        if not apps_:
            return
        client = self.svc.client
        try:
            stats = health.parse_app_stats(client.request("POST", f"/sdwan/monitor/{config.V.AIOPS_STATS}/api/monitor/aiops/object_stats",
                                                           json=health.app_stats_body(apps_, start, end)))
        except ApiError as e:
            out["errors"].append(f"App health scores: {e}")
            return
        try:
            names = {s["id"]: s.get("name") or s["id"] for s in self.svc.sites()}
        except (ApiError, CacheError):
            names = {}
        pairs = [(a, sid, cat) for a in apps_ for cat in ("poor", "fair")
                 for sid in (stats.get(a) or {}).get("sites", {}).get(cat, [])]
        per_app = {}
        for a, sid, cat in pairs:
            if len(per_app.setdefault(a, [])) < config.HEALTH_APP_SITES:
                per_app[a].append((sid, cat))
        pairs = [(a, sid, cat) for a, sites in per_app.items() for sid, cat in sites]

        def counters(pair):
            a, sid, _ = pair
            resp, _err = _safe(lambda: client.request("POST", f"/sdwan/monitor/{config.V.AIOPS_STATS}/api/monitor/aiops/aggregates",
                                                      json=health.app_site_body(a, sid, start, end)))
            return health.parse_app_site(resp) if resp else None

        def perf(pair):
            a, sid, _ = pair
            try:
                return health.parse_app_perf(apps.query_metrics(client, apps.PERF_METRICS, {"site": [sid], "app": [a]},
                                                                apps.APP_VIEW, start, end, interval="5min")), None
            except ApiError as e:
                return {}, str(e)

        with pool(workers=config.ENDPOINT_CONCURRENCY["aiops"]) as ex_a, pool(workers=config.ENDPOINT_CONCURRENCY["metrics"]) as ex_m:
            f_counts = [ex_a.submit(counters, p) for p in pairs]
            f_perf = [ex_m.submit(perf, p) for p in pairs]
            results = [(p, fc.result(), fp.result()) for p, fc, fp in zip(pairs, f_counts, f_perf)]
        for a in apps_:
            st = stats.get(a)
            item = out["items"]["apps"].setdefault(a, {"timeline": health.timeline(cats.get(a, {}), out["slots"])})
            rows = [(sid, cat, c, pf) for (aa, sid, cat), c, pf in results if aa == a]
            item["aiops"] = {"score": st and st["score"],
                             "sites": [{"id": sid, "name": names.get(sid, sid), "cat": cat, "counters": c} for sid, cat, c, _ in rows]}
            causes = []
            for sid, _cat, c, (pf, err) in rows:
                cause = health.app_cause(cats.get(a, {}), pf, c)
                if err:
                    cause["note"] = f"Response times didn't load: {err}"
                causes.append({"site": names.get(sid, sid), **cause})
            item["cause"] = {"sites": causes}

    # ---- the tenant's applications ------------------------------------------------------------------

    @staticmethod
    def _snapshot_key(exclude_dc):
        return f"tenantapps:{'nodc' if exclude_dc else 'all'}"

    @property
    def _db(self):
        return self.svc.site_details.store.db

    def _entry(self, exclude_dc):
        """The list's state (under self._lock); the first use since start is seeded with the saved list."""
        entry = self._apps.get(exclude_dc)
        if entry is None:
            try:
                body, saved = self._db.load_snapshot(self.svc.tsg_id, self._snapshot_key(exclude_dc))
            except Exception:  # noqa: BLE001 - the cache is optional
                body, saved = None, 0.0
            entry = self._apps[exclude_dc] = {"result": body, "finished": saved if body else 0.0,
                                              "running": False, "error": None, "error_at": 0.0}
        return entry

    def tenant_apps(self, exclude_dc=True):
        """{generated_at, start_time, end_time, site_count, apps (None until the first list), status
        "complete" | "running" | "error", error}. Starts a rebuild when the list is older than
        TENANT_APPS_CACHE_S (not within APPS_ERROR_RETRY_S of a failure); the last list is returned
        meanwhile."""
        exclude_dc = bool(exclude_dc)
        spawn = None
        with self._lock:
            e = self._entry(exclude_dc)
            fresh = e["result"] is not None and self._clock() - e["finished"] < config.TENANT_APPS_CACHE_S
            failed_recently = e["error"] and self._clock() - e["error_at"] < config.APPS_ERROR_RETRY_S
            if not fresh and not e["running"] and not failed_recently:
                e.update(running=True, error=None)
                spawn = e["result"] is not None  # background priority when there's a list to show
            status = "running" if e["running"] else "complete" if fresh else "error" if e["error"] else "running"
            r = e["result"] or {}
            view = {"generated_at": r.get("generated_at"), "start_time": r.get("start_time"), "end_time": r.get("end_time"),
                    "site_count": r.get("site_count"), "apps": r.get("apps"), "status": status, "error": e["error"]}
        if spawn is not None:
            threading.Thread(target=self._run, args=(exclude_dc, spawn), daemon=True, name=f"tenant-apps-{self.svc.tsg_id}").start()
        return view

    def _run(self, exclude_dc, background):
        set_background(background)
        try:
            result = self._build_apps(exclude_dc)
        except Exception as e:  # noqa: BLE001 - shown on the page; retried after APPS_ERROR_RETRY_S
            if not isinstance(e, (ApiError, CacheError)):
                print(f"[tenant apps {self.svc.tsg_id}] failed:", file=sys.stderr)
                traceback.print_exc()
            with self._lock:
                self._apps[exclude_dc].update(running=False, error=str(e), error_at=self._clock())
            return
        with self._lock:
            self._apps[exclude_dc].update(result=result, finished=self._clock(), running=False, error=None)
        try:
            self._db.save_snapshot(self.svc.tsg_id, self._snapshot_key(exclude_dc), result)
        except Exception:  # noqa: BLE001 - the cache is optional
            pass

    def _site_ids(self, exclude_dc):
        """(the Overview's site ids, those with an ION, sorted): sites without any ION have no traffic
        to report (an ION list up to 5 minutes old will do)."""
        shown = [s["id"] for s in self.svc.sites() if not (exclude_dc and overview.is_data_center(s))]
        elements, _ = _safe(lambda: self.svc.elements(max_age=config.APPS_ELEMENTS_AGE_S)[1])
        with_ions = {e.get("site_id") for e in elements} if elements is not None else None
        return shown, sorted(s for s in shown if with_ions is None or s in with_ions)

    def _build_apps(self, exclude_dc):
        end = minute_floor()
        start = end - config.TENANT_APPS_WINDOW
        shown, ids = self._site_ids(exclude_dc)
        chunks = [ids[i:i + config.TENANT_APPS_SITE_CHUNK] for i in range(0, len(ids), config.TENANT_APPS_SITE_CHUNK)]
        totals = {}
        with pool(workers=config.ENDPOINT_CONCURRENCY["appstats"]) as ex:
            for stats in ex.map(lambda chunk: apps.app_stats(self.svc.client, chunk, start, end), chunks):
                for a in stats.values():
                    t = totals.setdefault(a["id"], {k: 0 for k in a if k != "id"})
                    for k, v in a.items():
                        if k != "id":
                            t[k] += v
        stats = {a: {"id": a, **{k: round(v, 4) if isinstance(v, float) else v for k, v in t.items()}} for a, t in totals.items()}
        return {"generated_at": now_iso(), "start_time": iso(start), "end_time": iso(end), "site_count": len(shown),
                "apps": apps.named_apps(stats, self.svc.top_apps.names() if stats else {})}

    # ---- one app per site ---------------------------------------------------------------------------

    def app_sites(self, app_id, exclude_dc=True):
        """Where one app of the list fails: {app_id, generated_at, start_time, end_time, site_count,
        sites: [{id, name, flows, tcp_flows, failed_connections, failed_txn}] (None until built), status
        "complete" | "running" | "error", error, progress: {done, total}}. One monitor/metrics query (or
        two) per METRICS_BATCH sites, on a background thread, kept APP_SITES_CACHE_S."""
        key = (app_id, bool(exclude_dc))
        spawn = False
        with self._lock:
            now = self._clock()
            for k in [k for k, e in self._by_app.items() if not e["running"] and now - e["finished"] > config.APP_SITES_CACHE_S
                      and now - e["error_at"] > config.APPS_ERROR_RETRY_S]:
                del self._by_app[k]
            e = self._by_app.setdefault(key, {"result": None, "finished": 0.0, "running": False, "error": None,
                                              "error_at": 0.0, "progress": None})
            fresh = e["result"] is not None and now - e["finished"] < config.APP_SITES_CACHE_S
            failed_recently = e["error"] and now - e["error_at"] < config.APPS_ERROR_RETRY_S
            if not fresh and not e["running"] and not failed_recently:
                e.update(running=True, error=None, progress=None)
                spawn = True
            status = "running" if e["running"] else "complete" if fresh else "error"
            view = {"app_id": app_id, **(e["result"] or {"sites": None}), "status": status, "error": e["error"],
                    "progress": e["progress"]}
        if spawn:
            threading.Thread(target=self._run_app_sites, args=(key,), daemon=True, name=f"app-sites-{self.svc.tsg_id}").start()
        return view

    def _run_app_sites(self, key):
        app_id, exclude_dc = key
        try:
            end = minute_floor()
            start = end - config.TENANT_APPS_WINDOW
            shown, ids = self._site_ids(exclude_dc)
            chunks = [ids[i:i + config.METRICS_BATCH] for i in range(0, len(ids), config.METRICS_BATCH)]
            per_site, done = {}, 0
            with self._lock:
                self._by_app[key]["progress"] = {"done": 0, "total": len(chunks)}
            with pool(workers=config.ENDPOINT_CONCURRENCY["metrics"]) as ex:
                for stats in ex.map(lambda chunk: apps.app_site_stats(self.svc.client, app_id, chunk, start, end), chunks):
                    per_site.update(stats)
                    done += 1
                    with self._lock:
                        self._by_app[key]["progress"] = {"done": done, "total": len(chunks)}
            names = {s["id"]: s.get("name") or s["id"] for s in self.svc.sites()}
            sites = sorted(({"id": sid, "name": names.get(sid, sid), **t} for sid, t in per_site.items() if t["flows"] or t["failed_connections"]),
                           key=lambda s: (-s["failed_connections"], -s["failed_txn"], -s["flows"], s["name"]))
            result = {"generated_at": now_iso(), "start_time": iso(start), "end_time": iso(end), "site_count": len(shown), "sites": sites}
        except Exception as e:  # noqa: BLE001 - shown in the dialog; retried after APPS_ERROR_RETRY_S
            if not isinstance(e, (ApiError, CacheError)):
                print(f"[app sites {self.svc.tsg_id}] failed:", file=sys.stderr)
                traceback.print_exc()
            with self._lock:
                self._by_app[key].update(running=False, error=str(e), error_at=self._clock())
            return
        with self._lock:
            self._by_app[key].update(result=result, finished=self._clock(), running=False, error=None)
