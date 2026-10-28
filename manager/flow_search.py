"""Flow Search: search jobs over monitor/flows, the hour cache, and the names the page shows for ids.

A search runs on a background thread as a job the page polls (start, poll with ?since=, stop, keep
going). Its range is read as hourly windows (sdwan.flows.windows), every site's newest hour first, so
each site's most recent flows arrive early; each window is paged until a short page. Requests go
through the tenant's client like every other call: one sign-in per tenant, the "flows" pacing gate (2
in flight per tenant, so two searching tabs share it rather than drawing 429s) and its retries. 1.x
ran Flow Search on the prisma_sase SDK with a sign-in of its own and per-search request slots.

A flow seen in a second window (open across an hour boundary) is sent as an update the page merges
into it; one seen again in the same window (the other direction of an "either" IP search) is dropped.
Whole past hours read in full go to data/flowcache.db and are reused by any later search with the
same site and filters. A search pauses every FLOW_SOFT_CAP flows (every flow is held in the browser),
and stops once its page stops polling.
"""
import math
import secrets
import sys
import threading
import time

from . import config
from .api.cache import CacheError
from .api.client import ApiError
from .api.pacing import pool
from .persist import FlowCache
from .sdwan import apps, flows, topology


class UnknownJob(Exception):
    pass


class _Job:
    """One search: its spec, the batches waiting for the page, progress, and stop / pause."""

    def __init__(self, job_id, spec, windows, fields, clock):
        self.id = job_id
        self.spec = spec
        self.windows = windows
        self.fields = fields
        self._clock = clock
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self._running = threading.Event()
        self._running.set()
        self.batches = []          # [{"site_id", "flows", "updates"}]; delivered ones are set to None
        self.acked = 0
        self.flow_count = 0        # new flows so far (not updates), for the soft cap
        self.pause_at = config.FLOW_SOFT_CAP
        self.paused = False
        self.done = False
        self.last_polled = clock()
        per_site = len(windows) * len(fields)
        span = (spec["end"] - spec["start"]).total_seconds() * len(fields)
        self.sites = {sid: {"seen": {}, "left": per_site, "failures": [], "cached": 0, "complete": 0,
                            "total_s": span, "done_s": 0.0, "flows": 0, "active": {}, "meta": None}
                      for sid in spec["site_ids"]}
        self.completed = []        # site ids in the order they finished

    # ---- control (fetch threads) ----------------------------------------------------------------

    def proceed(self):
        """Wait while paused; False once stopped, or when the page stopped polling (its tab closed
        without the Stop on pagehide getting through)."""
        while True:
            if self._clock() - self.last_polled > config.FLOW_JOB_ABANDON_S:
                self.stop_event.set()
            if self.stop_event.is_set():
                return False
            if self._running.wait(1):
                return not self.stop_event.is_set()

    def stop(self):
        self.stop_event.set()
        self._running.set()

    def resume(self):
        with self.lock:
            if self.paused:
                self.paused = False
                self.pause_at = self.flow_count + config.FLOW_SOFT_CAP
                self._running.set()

    # ---- results (fetch threads) ----------------------------------------------------------------

    def add(self, site_id, window, items):
        """A page of a window's flows: new ones as flows, ones seen in another window as updates."""
        fresh, updates = [], []
        with self.lock:
            seen = self.sites[site_id]["seen"]
            for flow in items:
                k = flows.key(flow)
                windows = seen.get(k)
                if windows is None:
                    seen[k] = {window}
                    fresh.append(flow)
                elif window not in windows:
                    windows.add(window)
                    updates.append(flow)
            if not fresh and not updates:
                return
            self.batches.append({"site_id": site_id, "flows": fresh, "updates": updates})
            self.flow_count += len(fresh)
            if self.flow_count >= self.pause_at and not self.paused:
                self.paused = True
                self._running.clear()

    def reading(self, site_id, token, count):
        """A window being read from the API has count flows so far (None: it ended)."""
        with self.lock:
            active = self.sites[site_id]["active"]
            if count is None:
                active.pop(token, None)
            else:
                active[token] = count

    def finished(self, site_id, window, field, count, cached=False, failure=None, token=None):
        """A window ended: read in full (count flows), from the cache, failed or stopped (count None)."""
        with self.lock:
            s = self.sites[site_id]
            s["active"].pop(token, None)
            s["left"] -= 1
            if failure:
                s["failures"].append((window, field, *failure))
            elif count is not None:
                s["complete"] += 1
                s["cached"] += cached
                s["done_s"] += (window[1] - window[0]).total_seconds()
                s["flows"] += count
            if s["left"] == 0:
                s["meta"] = self._site_meta(s)
                self.completed.append(site_id)

    def _site_meta(self, s):
        total = len(self.windows) * len(self.fields)
        if s["failures"] and len(s["failures"]) == total:
            return {"error": s["failures"][0][3], "warning": None, "cached_windows": 0, "windows": total}
        notes = []
        if self.stop_event.is_set():
            notes.append("Stopped before the search finished.")
        if s["failures"]:
            (ws, we), field, page, err = sorted(s["failures"], key=lambda f: f[0], reverse=True)[0]
            direction = {"source_ip": " (Source-IP query)", "destination_ip": " (Destination-IP query)"}.get(field, "") \
                if len(self.fields) > 1 else ""
            notes.append(f"{len(s['failures'])} of {total} hourly windows failed (newest: {ws:%Y-%m-%d %H:%M}–{we:%H:%M} UTC"
                         f"{direction}, page {page}: {err}).")
        return {"error": None, "warning": " ".join(notes) or None, "cached_windows": s["cached"], "windows": total}

    # ---- the page's poll -------------------------------------------------------------------------

    def view(self, since):
        """Batches added since `since` (the previous poll's next), freeing those before it."""
        with self.lock:
            self.last_polled = self._clock()
            acked_to = min(since, len(self.batches))
            for i in range(self.acked, acked_to):
                self.batches[i] = None
            self.acked = max(self.acked, acked_to)
            batches = self.batches[since:]
            done_s, active = self._windows_done()
            return {
                "total": len(self.sites),
                "completed_site_ids": list(self.completed),
                "site_meta": {sid: s["meta"] for sid, s in self.sites.items() if s["meta"]},
                "batches": batches,
                "next": since + len(batches),
                "done": self.done,
                "paused": self.paused,
                "estimate": None if self.done else self._estimate(),
                "windows_total": len(self.sites) * len(self.windows) * len(self.fields),
                "windows_done": done_s,
                "windows_active": active,
            }

    def drained(self, next_index):
        return self.done and next_index >= len(self.batches)

    def _windows_done(self):
        """(done, active): windows read so far over every site, and how many are being read. done
        counts finished windows plus a share of each one being read, once its site has finished one
        to judge by (flows so far against the site's flows per hour, at most 90%: the API gives no
        total). Failed and stopped windows never count."""
        hour_s = config.FLOW_WINDOW.total_seconds()
        done = active = 0
        for s in self.sites.values():
            done += s["complete"]
            active += len(s["active"])
            if s["done_s"] and s["flows"]:
                expected = s["flows"] / s["done_s"] * hour_s
                done += sum(min(0.9, n / expected) for n in s["active"].values())
        return round(done, 2), active

    def _estimate(self):
        """{"flows", "seconds"} projected for the whole search (seconds: time left at the API's rate,
        an upper bound since cached hours are free) once every site that has started has read an hour
        of its range (or all of it); sites not started count as the average. None before."""
        flows_n = requests = 0
        started = 0
        for sid, s in self.sites.items():
            if sid in self.completed:
                flows_n += s["flows"]
                started += 1
                continue
            if not s["done_s"] and not s["active"]:
                continue  # not started
            if s["done_s"] < min(config.FLOW_WINDOW.total_seconds(), s["total_s"]):
                return None
            per_s = s["flows"] / s["done_s"]
            flows_n += round(per_s * s["total_s"])
            requests += s["left"] * max(1, math.ceil(per_s * config.FLOW_WINDOW.total_seconds() / config.FLOW_PAGE_SIZE))
            started += 1
        if not started:
            return None
        waiting = len(self.sites) - started
        if waiting:
            flows_n += round(flows_n / started * waiting)
            requests += round(requests / started * waiting)
        return {"flows": flows_n, "seconds": round(requests / config.FLOW_REQUESTS_PER_S)}


class FlowSearch:
    """Flow Search for one tenant. svc is its TenantService."""

    def __init__(self, svc, clock=time.time, cache=None):
        self.svc = svc
        self._clock = clock
        self._cache = cache or FlowCache()
        self._lock = threading.Lock()
        self._jobs = {}
        self._policies_failed_at = None

    # ---- what the search form and table name --------------------------------------------------------

    def sites(self):
        """Sites that can be searched: active and not a data center (as 1.x), by name."""
        return sorted(({"id": s["id"], "name": s.get("name") or s["id"]} for s in self.svc.sites()
                       if s.get("admin_state") == "active" and s.get("element_cluster_role") != "HUB"),
                      key=lambda s: s["name"].lower())

    def apps(self):
        """Every app definition [{id, name}] by name (the same cached names as Top applications)."""
        names = self.svc.top_apps.names()
        if not names:  # the cached fetch failed with nothing to fall back on: say why
            names = apps.app_names(self.svc.client)
        return sorted(({"id": i, "name": n} for i, n in names.items()), key=lambda a: a["name"].lower())

    def paths(self):
        """path id -> name (a string, or {"name", "by_site"} named from each end): the same topology
        names as link alarms."""
        names = self.svc.site_health.topology_names(set())
        if names:
            return names
        site_names = {s["id"]: s.get("name") for s in self.svc.sites()}
        return topology.link_names(topology.fetch(self.svc.client), site_names)

    def policies(self):
        """{network, priority, security: {rule id: name}, probe_slas: {app id: [...]}}, cached
        FLOW_NAMES_CACHE_S; a failed refresh serves the last ones."""
        try:
            return self.svc.cache.get("flow_policies", config.FLOW_NAMES_CACHE_S, self._build_policies)
        except (ApiError, CacheError):
            stale = self.svc.cache.peek("flow_policies")
            if stale is None:
                raise
            return stale

    def _build_policies(self):
        client = self.svc.client

        def kind_names(kind):
            sets_path, rules_path, query_path = flows.POLICY_KINDS[kind]
            try:
                rules = flows.rules_by_query(client, query_path)
            except ApiError as e:
                print(f"{kind} rules query failed, reading each policy set: {e}", file=sys.stderr, flush=True)
                rules = None
            if rules is None:
                sets = client.get_items(sets_path)
                with pool() as ex:
                    rules = [r for rs in ex.map(lambda ps: client.get_items(rules_path.format(ps["id"])), sets) for r in rs]
            return flows.rule_names(rules)

        with pool() as ex:
            futures = {kind: ex.submit(kind_names, kind) for kind in flows.POLICY_KINDS}
            out = {kind: f.result() for kind, f in futures.items()}
        try:
            rules, thresholds = self.svc.probes.perf_policy()
            out["probe_slas"] = flows.probe_slas(rules, thresholds, self.svc.probes.probe_configs())
        except (ApiError, CacheError) as e:  # optional detail: never fail the names
            print(f"probe SLAs for Flow Search failed: {e}", file=sys.stderr, flush=True)
            out["probe_slas"] = {}
        return out

    # ---- search jobs ----------------------------------------------------------------------------

    def start(self, body):
        spec = flows.parse_search(body)
        windows = flows.windows(spec["start"], spec["end"])
        fields = flows.ip_fields(spec["ip_address"], spec["ip_mode"])
        self.svc.client.ensure_token()  # a sign-in failure answers the request, not the job
        self._prune()
        job = _Job(secrets.token_hex(16), spec, windows, fields, self._clock)
        with self._lock:
            self._jobs[job.id] = job
        threading.Thread(target=self._run, args=(job,), daemon=True, name=f"flows-{job.id[:6]}").start()
        return {"job_id": job.id, "total": len(job.sites), "page_size": config.FLOW_PAGE_SIZE,
                "soft_cap": config.FLOW_SOFT_CAP}

    def _job(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise UnknownJob(job_id)
        return job

    def poll(self, job_id, since):
        job = self._job(job_id)
        view = job.view(since)
        if job.drained(view["next"]):
            with self._lock:
                self._jobs.pop(job_id, None)
        return view

    def stop(self, job_id):
        self._job(job_id).stop()
        return {"ok": True}

    def resume(self, job_id):
        self._job(job_id).resume()
        return {"ok": True}

    def _prune(self):
        cutoff = self._clock() - config.FLOW_JOB_TTL_S
        with self._lock:
            for job_id in [j for j, job in self._jobs.items() if job.last_polled < cutoff]:
                self._jobs.pop(job_id).stop()

    def close(self):
        with self._lock:
            jobs, self._jobs = list(self._jobs.values()), {}
        for job in jobs:
            job.stop()
        self._cache.close()

    # ---- running a job ----------------------------------------------------------------------------

    def _run(self, job):
        # Every site's newest hour first, then the next hour back: each site's latest flows show early.
        tasks = [(site_id, field, window) for window in job.windows for site_id in job.sites for field in job.fields]
        try:
            with pool(background=False, workers=config.ENDPOINT_CONCURRENCY["flows"]) as ex:
                for _ in ex.map(lambda t: self._window(job, *t), tasks):
                    pass
        finally:
            with job.lock:
                job.done = True

    def _window(self, job, site_id, field, window):
        try:
            self._read_window(job, site_id, field, window)
        except Exception as e:  # noqa: BLE001 - e.g. a cache write error: the window fails, the job goes on
            print(f"flow search {job.id} {site_id} {window[0]:%H:%M} failed: {e!r}", file=sys.stderr, flush=True)
            job.finished(site_id, window, field, None, failure=(1, f"Search failed: {e or type(e).__name__}"))

    def _read_window(self, job, site_id, field, window):
        if not job.proceed():
            job.finished(site_id, window, field, None)
            return
        key = flows.window_key(self.svc.tsg_id, job.spec, site_id, field, window)
        if key:
            hit = self._cache.load(key)
            if hit is not None:
                if hit:
                    job.add(site_id, window, hit)
                job.finished(site_id, window, field, len(hit), cached=True)
                return
        collected = [] if key else None
        token, count, page, first = object(), 0, 1, None
        job.reading(site_id, token, 0)
        try:
            while job.proceed():
                body = flows.payload(job.spec, site_id, field, *window, page)
                try:
                    resp = self.svc.client.request("POST", flows.PATH, json=body)
                except ApiError as e:
                    job.finished(site_id, window, field, None, failure=(page, str(e)), token=token)
                    return
                raw = (resp.get("flows") or {}).get("items") or []
                items = [flows.slim(f) for f in raw]
                sig = flows.key(items[0]) if items else None
                if page == 1:
                    first = sig
                elif sig is not None and sig == first:  # the API ignored dest_page
                    job.finished(site_id, window, field, None,
                                 failure=(page, "the API returned page 1 again when asked for the next page"), token=token)
                    return
                if items:
                    job.add(site_id, window, items)
                    count += len(items)
                    if collected is not None:
                        collected.extend(items)
                    job.reading(site_id, token, count)
                if len(raw) < config.FLOW_PAGE_SIZE:
                    if key:
                        self._cache.save(key, collected)
                    job.finished(site_id, window, field, count, token=token)
                    return
                page += 1
            job.finished(site_id, window, field, None, token=token)  # stopped
        finally:
            job.reading(site_id, token, None)

