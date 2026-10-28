"""Site details: Top applications.

One job per site and period, on a background thread: the app list (one or two applicationstats
queries), and, only when someone presses "Load RTT" / "Load app unreachable" (or "Refresh RTT" etc. once
loaded), RTT (one metrics query per app) and app unreachable (one aggregates query per app) for the
apps sdwan.apps.candidates picks. The two run at the same time: they're different endpoint families,
each with its own concurrency cap. A result is reused for TOP_APPS_CACHE_S and saved to
data/cache.db, so it shows at once after a restart; an older one stays on the page while the next
poll's refresh runs. Only a site someone has open asks for its list. Rebuilding the list never
fetches RTT or app unreachable: what was loaded is carried over onto the new list as it was, with
its own time, until the next press.

The Details dialog (one app, on demand): one metrics query for its response times and transactions
and one PrefixList query, run together and cached APP_DETAIL_CACHE_S.
"""
import sys
import threading
import time
import traceback
from concurrent.futures import FIRST_COMPLETED, wait
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone

from . import config
from .api.cache import CacheError
from .api.client import ApiError
from .api.pacing import pool, set_background
from .sdwan import apps
from .timeutil import iso, minute_floor, now_iso, parse_iso

ENRICHMENTS = ("rtt", "unreachable")
APP_FIELD = {"rtt": "rtt", "unreachable": "app_unreachable"}
FAMILY = {"rtt": "metrics", "unreachable": "aggregates"}  # pacing gate of each kind's queries


def _at(epoch):
    return iso(datetime.fromtimestamp(epoch, timezone.utc))


def _carry_over(base, old):
    """The new list base with the RTT and app unreachable loaded on the old result, as they were
    (same values, same fetch time and window), for the apps still in the list."""
    if not old:
        return base
    result = {**base, "apps": [dict(a) for a in base["apps"]]}
    by_id = {a["id"]: a for a in old.get("apps") or []}
    for kind in ENRICHMENTS:
        info = old.get(kind)
        if not info:
            continue
        # A result saved before loads carried their own times was fetched with its list.
        result[kind] = {"fetched_at": old.get("generated_at"), "start_time": old.get("start_time"),
                        "end_time": old.get("end_time"), **info}
        for a in result["apps"]:
            prev = by_id.get(a["id"], {})
            for field in (APP_FIELD[kind], f"{kind}_error"):
                if field in prev:
                    a[field] = prev[field]
    return result


class TopApps:
    """Top applications for one tenant. svc is its TenantService."""

    def __init__(self, svc, clock=time.time):
        self.svc = svc
        self._clock = clock
        self._lock = threading.Lock()
        self._jobs = {}       # (site_id, hours) -> job state, see _job
        self._details = {}    # site_id -> Details cache keys, dropped with the site

    @property
    def _db(self):
        return self.svc.site_details.store.db

    @staticmethod
    def _snapshot_key(site_id, hours):
        return f"topapps:{site_id}:{hours}h"

    def _job(self, site_id, hours):
        """The job for a site and period (under self._lock). The first use since start is seeded
        with the saved result, which is shown at once: as the answer if fresh, else while a refresh
        runs. Its RTT and app unreachable stay as they are (want starts empty)."""
        key = (site_id, hours)
        job = self._jobs.get(key)
        if job is None:
            try:
                body, saved = self._db.load_snapshot(self.svc.tsg_id, self._snapshot_key(site_id, hours))
            except Exception:  # noqa: BLE001 - the cache is optional
                body, saved = None, 0.0
            job = self._jobs[key] = {
                "running": False, "result": body, "finished": saved if body else 0.0,
                "error": None, "error_at": 0.0, "progress": None, "manual_at": 0.0,
                "want": set(),  # enrichments asked for and not fetched yet
            }
        return job

    def _fresh(self, job):
        return job["result"] is not None and self._clock() - job["finished"] < config.TOP_APPS_CACHE_S

    def _hub(self, site_id):
        """Whether the site is a data center (UnknownSite if there's no such site). Apps aren't
        tracked at data centers, so nothing is fetched for one."""
        return self.svc.site_details._site(site_id).get("element_cluster_role") == "HUB"

    # ---- what the page calls --------------------------------------------------------------------

    def snapshot(self, site_id, hours):
        """The site's Top applications for the period, with status "complete" | "running" | "error"
        (or "data_center": none fetched). Starts a refresh when there's no fresh result (not again
        within APPS_ERROR_RETRY_S of a failure), at background priority unless the page has nothing
        to show yet."""
        if self._hub(site_id):
            return {"site_id": site_id, "window_hours": hours, "apps": None, "status": "data_center", "error": None}
        start = None
        with self._lock:
            job = self._job(site_id, hours)
            failed_recently = job["error"] and self._clock() - job["error_at"] < config.APPS_ERROR_RETRY_S
            if not job["running"] and not self._fresh(job) and not failed_recently:
                job.update(running=True, error=None)
                start = job["result"] is not None
            view = self._view(job, site_id, hours)
        if start is not None:
            self._spawn(site_id, hours, with_list=True, background=start)
        return view

    def load(self, site_id, hours, kind):
        """"Load RTT" / "Load app unreachable" (kind "rtt" | "unreachable"), also "Refresh RTT" etc.
        once loaded: fetch it for the list now, at interactive priority. Only this fetches it."""
        if self._hub(site_id):
            return {"status": "data_center"}
        with self._lock:
            job = self._job(site_id, hours)
            job["want"].add(kind)
            if job["running"]:
                return {"status": "running"}  # the running job picks it up
            job.update(running=True, error=None)
            with_list = job["result"] is None
        self._spawn(site_id, hours, with_list=with_list, background=False)
        return {"status": "running"}

    def refresh_now(self, site_id, hours):
        """"Refresh now": rebuild the list whatever its age, at interactive priority, at most once
        per REFRESH_NOW_MIN_S. The last result stays up meanwhile; RTT and app unreachable carry over."""
        if self._hub(site_id):
            return {"status": "data_center"}
        with self._lock:
            job = self._job(site_id, hours)
            if job["running"]:
                return {"status": "running"}
            since = self._clock() - job["manual_at"]
            if since < config.REFRESH_NOW_MIN_S:
                return {"status": "recent", "retry_in_s": int(config.REFRESH_NOW_MIN_S - since)}
            job.update(running=True, error=None, manual_at=self._clock())
        self._spawn(site_id, hours, with_list=True, background=False)
        return {"status": "running"}

    def _view(self, job, site_id, hours):
        r = job["result"] or {}
        now = self._clock()
        status = "running" if job["running"] else "complete" if self._fresh(job) else "error" if job["error"] else "running"
        ready = job["manual_at"] + config.REFRESH_NOW_MIN_S

        def enrichment(kind):
            info = r.get(kind)
            state = "pending" if kind in job["want"] and job["running"] else "loaded" if info else "off"
            return {"state": state, **(info or {})}
        return {
            "site_id": site_id, "window_hours": hours,
            "start_time": r.get("start_time"), "end_time": r.get("end_time"), "generated_at": r.get("generated_at"),
            "apps": r.get("apps"),  # None until the first list
            "status": status, "error": job["error"],
            "progress": job["progress"] if job["running"] else None,
            "next_refresh_at": _at(job["finished"] + config.TOP_APPS_CACHE_S) if status == "complete" else None,
            "refresh_ready_at": _at(ready) if job["manual_at"] and now < ready else None,
            "rtt": enrichment("rtt"), "unreachable": enrichment("unreachable"),
        }

    # ---- the job --------------------------------------------------------------------------------

    def _spawn(self, site_id, hours, with_list, background):
        threading.Thread(target=self._run, args=(site_id, hours, with_list, background), daemon=True,
                         name=f"top-apps-{site_id}-{hours}h").start()

    def _set_progress(self, key, progress):
        with self._lock:
            self._jobs[key]["progress"] = progress

    def _run(self, site_id, hours, with_list, background):
        """Build the list (with_list) and/or the enrichments asked for; the caller has set running.
        Enrichments asked for meanwhile follow in another run."""
        set_background(background)
        key = (site_id, hours)
        try:
            if with_list:
                self._set_progress(key, {"phase": "list", "started": self._clock()})
                base = self._build_list(site_id, hours)
                with self._lock:
                    job = self._jobs[key]
                    base = _carry_over(base, job["result"])
                    kinds = sorted(job["want"])
                    job["result"] = base
            else:
                with self._lock:
                    job = self._jobs[key]
                    base = job["result"]
                    kinds = sorted(job["want"])
            result = self._enrich(key, base, kinds) if kinds else base
            with self._lock:
                job = self._jobs[key]
                job["result"] = result
                if with_list:
                    job["finished"] = self._clock()
            try:
                self._db.save_snapshot(self.svc.tsg_id, self._snapshot_key(site_id, hours), result)
            except Exception:  # noqa: BLE001 - the cache is optional
                pass
        except Exception as e:  # noqa: BLE001 - shown on the page; the next poll retries
            if not isinstance(e, ApiError):  # a bug: worth the traceback
                print(f"[top apps {site_id} {hours}h] failed:", file=sys.stderr)
                traceback.print_exc()
            with self._lock:
                self._jobs[key].update(error=str(e) if isinstance(e, ApiError) else f"{type(e).__name__}: {e}",
                                       error_at=self._clock())
        finally:
            with self._lock:
                job = self._jobs[key]
                if job["error"]:
                    job["want"].clear()  # asked again with the next press
                more = bool(job["result"] and job["want"])
                job.update(running=more, progress=None)
            if more:
                self._spawn(site_id, hours, with_list=False, background=False)

    def _build_list(self, site_id, hours):
        end = minute_floor()
        start = end - timedelta(hours=hours)
        # Which sites have IONs changes rarely: a copy of the ION list up to 5 minutes old will do
        # (its own cache is 5 s, so most builds would cost a call).
        try:
            elements = self.svc.elements(max_age=config.APPS_ELEMENTS_AGE_S)[1]
        except (ApiError, CacheError):
            elements = None
        # A site without any ION has no traffic to report (the list would cost two calls for nothing).
        if elements is not None and not any(e.get("site_id") == site_id for e in elements):
            stats = {}
        else:
            stats = apps.app_stats(self.svc.client, [site_id], start, end)
        return {"site_id": site_id, "window_hours": hours, "start_time": iso(start), "end_time": iso(end),
                "generated_at": now_iso(), "apps": apps.named_apps(stats, self.names() if stats else {}),
                "rtt": None, "unreachable": None}

    def names(self):
        """App names, refreshed every APP_NAMES_CACHE_S. A failed fetch keeps the last names (with
        none yet, ids show in their place) rather than failing the list."""
        try:
            return self.svc.cache.get("app_names", config.APP_NAMES_CACHE_S, lambda: apps.app_names(self.svc.client))
        except (ApiError, CacheError):
            return self.svc.cache.peek("app_names") or {}

    def _enrich(self, key, base, kinds):
        """A copy of base with each of kinds ("rtt", "unreachable") over the list's own window, all
        queries at once, each kind in its own pool sized to its endpoint family's gate (so RTT queries
        waiting on the metrics gate don't hold up the aggregates ones). A kind asked for while this
        runs joins it. Each is shown as soon as its last query is in (until then, what was loaded
        before stays up)."""
        site_id = base["site_id"]
        start, end = parse_iso(base["start_time"]), parse_iso(base["end_time"])
        result = {**base, "apps": [dict(a) for a in base["apps"]]}
        by_id = {a["id"]: a for a in result["apps"]}
        client = self.svc.client
        kinds = list(kinds)
        todo, found, errors, progress = {}, {}, {}, {"phase": "enrich"}

        def fetch(kind, app_id):
            if kind == "rtt":
                return apps.app_rtt(client, site_id, app_id, start, end)
            r = apps.prefix_events(client, site_id, app_id, start, end)
            return r["app_unreachable"], r.get("prefix_error")

        def show_progress():
            with self._lock:
                self._jobs[key]["progress"] = {**progress, **{k: dict(progress[k]) for k in kinds}}

        def finish(kind):
            field = APP_FIELD[kind]
            for a in result["apps"]:  # replace what an earlier load left, apps not covered now included
                a.pop(field, None)
                a.pop(f"{kind}_error", None)
            for app_id, (value, err) in found[kind].items():
                by_id[app_id][field] = value
                if err:
                    by_id[app_id][f"{kind}_error"] = err
            result[kind] = {"covered": len(todo[kind]), "failed": len(errors[kind]),
                            "error": errors[kind][0] if errors[kind] else None, "fetched_at": now_iso(),
                            "start_time": base["start_time"], "end_time": base["end_time"]}
            with self._lock:
                job = self._jobs[key]
                job["want"].discard(kind)
                job["result"] = {**result, "apps": [dict(a) for a in result["apps"]]}

        futures = {}
        with ExitStack() as stack:
            def begin(kind):
                todo[kind] = apps.candidates(base["apps"], config.PREFIX_UNTRACKED_APPS if kind == "unreachable" else ())
                found[kind], errors[kind] = {}, []
                progress[kind] = {"done": 0, "total": len(todo[kind])}
                ex = stack.enter_context(pool(workers=config.ENDPOINT_CONCURRENCY[FAMILY[kind]]))
                futures.update({ex.submit(fetch, kind, app_id): (kind, app_id) for app_id in todo[kind]})
                if not todo[kind]:
                    finish(kind)

            for k in kinds:
                begin(k)
            show_progress()
            pending = set(futures)
            while True:
                with self._lock:
                    joining = sorted(k for k in self._jobs[key]["want"] if k not in kinds)
                for k in joining:
                    kinds.append(k)
                    begin(k)
                if joining:
                    pending |= {f for f, (k, _) in futures.items() if k in joining}
                    show_progress()
                if not pending:
                    break
                done, pending = wait(pending, timeout=0.25, return_when=FIRST_COMPLETED)
                for fut in done:
                    kind, app_id = futures[fut]
                    value, err = fut.result()
                    found[kind][app_id] = (value, err)
                    if err:
                        errors[kind].append(err)
                    progress[kind]["done"] += 1
                    if len(found[kind]) == len(todo[kind]):
                        finish(kind)
                if done:
                    show_progress()
        return result

    # ---- Details dialog ---------------------------------------------------------------------------

    def detail(self, site_id, app_id, hours):
        """One app over the last `hours`: response times and the failed-transaction rate, app
        unreachable and destination prefixes. A part that failed is fetched again next time."""
        self.svc.site_details._site(site_id)
        key = ("app_detail", site_id, app_id, hours)

        def fetch():
            end = minute_floor()
            start = end - timedelta(hours=hours)
            with pool() as ex:
                perf = ex.submit(apps.app_perf, self.svc.client, site_id, app_id, start, end)
                prefixes = ex.submit(apps.prefix_events, self.svc.client, site_id, app_id, start, end)
                return {"site_id": site_id, "app_id": app_id, "window_hours": hours, "start_time": iso(start),
                        "end_time": iso(end), "generated_at": now_iso(), **perf.result(), **prefixes.result()}
        result = self.svc.cache.get(key, config.APP_DETAIL_CACHE_S, fetch)
        with self._lock:
            self._details.setdefault(site_id, set()).add(key)
        if result.get("perf_error") or result.get("prefix_error"):
            self.svc.cache.discard(key)
        return result

    def forget(self, site_id):
        """The site left memory (Site details eviction): its finished jobs (saved) and Details."""
        with self._lock:
            for key in [k for k, job in self._jobs.items() if k[0] == site_id and not job["running"]]:
                del self._jobs[key]
            keys = self._details.pop(site_id, set())
        for key in keys:
            self.svc.cache.discard(key)
