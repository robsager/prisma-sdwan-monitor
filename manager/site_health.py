"""Site details: one site's device health and alarms.

Device health per site, every DEVICE_HEALTH_CACHE_S while the site is open: one sys_metrics query for
its connected IONs (an offline ION reports nothing), one status call per HA pair with an ION
connected, and elements/{id}/status only for an ION whose element record changed since its last
status, or after STATUS_MAX_AGE_S.

Alarms: the active ones come from the tenant-wide standing alarms the Overview uses (no call of
their own while the Overview is in use); cleared ones from one events/query per ALARM_HISTORY_CACHE_S
(paged). Link alarms are named from the tenant's topology, fetched only when the site has one.
"""
import threading
import time

from . import config
from .api.cache import CacheError
from .api.client import ApiError
from .api.pacing import pool
from .config import V
from .sdwan import alarms, devices, topology
from .timeutil import minute_floor, now_iso

STATUS_FORBIDDEN_TEXT = ("Uptime and connection times aren't available: this service account's role "
                         "can't read ION status (403).")
LINK_ENTITIES = ("anynetlinks", "vpnlinks")


def _safe(fn, *args):
    try:
        return fn(*args), None
    except (ApiError, CacheError) as e:
        return None, str(e)


class SiteHealth:
    """Device health and alarms for one tenant. svc is its TenantService. Its topology link names
    are shared with the Overview's AIOps health."""

    def __init__(self, svc, clock=time.time):
        self.svc = svc
        self._clock = clock
        self._lock = threading.Lock()
        self._status = {}               # element id -> {"key", "at", "value"}
        self._status_forbidden_at = None
        self._topology = {"names": None, "at": 0.0, "tried": 0.0}

    def _site_elements(self, site_id):
        self.svc.site_details._site(site_id)  # UnknownSite for a site not in the tenant
        return [e for e in self.svc.elements()[1] if e.get("site_id") == site_id]

    # ---- device health --------------------------------------------------------------------------

    def device_health(self, site_id):
        """{generated_at, devices: {element id: {...}}, error}. A part that fails (metrics, one
        ION's status, HA) leaves its fields out and says why in error."""
        return self.svc.cache.get(("health", site_id), config.DEVICE_HEALTH_CACHE_S, lambda: self._device_health(site_id))

    def _device_health(self, site_id):
        elements = self._site_elements(site_id)
        out = {e["id"]: {} for e in elements}
        errors = []
        online = [e for e in elements if e.get("connected")]
        clusters = {c for e in online if (c := devices.ha_cluster(e))}
        forbidden = self._status_forbidden()
        if forbidden:
            errors.append(STATUS_FORBIDDEN_TEXT)
        stale = [] if forbidden else [e for e in elements if self._cached_status(e) is None]
        if online or stale:
            self.svc.client.ensure_token()
        end = minute_floor()
        with pool() as ex:
            f_metrics = None
            if online:
                body = devices.sys_metrics_body(site_id, [e["id"] for e in online], end - config.SYS_METRICS_LOOKBACK, end)
                f_metrics = ex.submit(_safe, self.svc.client.request, "POST",
                                      f"/sdwan/monitor/{V.SYS_METRICS}/api/monitor/sys_metrics", body)
            f_ha = [ex.submit(_safe, self.svc.client.request, "GET", f"/sdwan/{V.SPOKECLUSTERS}/api/sites/{site_id}/spokeclusters/{c}/status")
                    for c in sorted(clusters)]
            f_status = {e["id"]: (e, ex.submit(self._fetch_status, e)) for e in stale}
            if f_metrics:
                resp, err = f_metrics.result()
                if err:
                    errors.append(f"Device metrics: {err}")
                for eid, values in devices.parse_sys_metrics(resp or {}).items():
                    if eid in out:
                        out[eid].update(values)
            for fut in f_ha:
                resp, err = fut.result()
                if err:
                    errors.append(f"HA status: {err}")
                for eid, ha in devices.ha_status(resp or {}).items():
                    if eid in out:
                        out[eid]["ha"] = ha
            for eid, (_, fut) in f_status.items():
                err = fut.result()
                if err:
                    errors.append(err)
        for e in elements:
            st = self._cached_status(e, any_age=True)
            if st:
                out[e["id"]].update(st)
        return {"generated_at": now_iso(), "devices": out, "error": "; ".join(dict.fromkeys(errors)) or None}

    @staticmethod
    def _status_key(element):
        # The controller rewrites the element record on every connect and disconnect (verified live),
        # so a reboot or reconnect changes this and the status is asked for again.
        return (element.get("_updated_on_utc"), bool(element.get("connected")))

    def _cached_status(self, element, any_age=False):
        """The ION's status if still current: same element record, younger than STATUS_MAX_AGE_S.
        any_age: whatever was last fetched for this record."""
        with self._lock:
            hit = self._status.get(element["id"])
        if not hit or (hit["key"] != self._status_key(element) and not any_age):
            return None
        if not any_age and self._clock() - hit["at"] >= config.STATUS_MAX_AGE_S:
            return None
        return hit["value"]

    def _fetch_status(self, element):
        """Fetch and keep one ION's status. None, or the error text."""
        try:
            st = self.svc.client.request("GET", f"/sdwan/{V.ELEMENT_STATUS}/api/elements/{element['id']}/status")
        except ApiError as e:
            if e.status == 403:  # some roles can't read it (seen live): stop asking for a while
                with self._lock:
                    self._status_forbidden_at = self._clock()
                return STATUS_FORBIDDEN_TEXT
            return f"Device status: {e}"
        with self._lock:
            self._status[element["id"]] = {"key": self._status_key(element), "at": self._clock(),
                                           "value": devices.element_status(st)}
        return None

    def _status_forbidden(self):
        with self._lock:
            at = self._status_forbidden_at
        return at is not None and self._clock() - at < config.STATUS_FORBIDDEN_RETRY_S

    # ---- alarms ---------------------------------------------------------------------------------

    def alarms(self, site_id):
        """{generated_at, active: [...], active_error, cleared: {...} | None, cleared_error,
        link_names: {link id: name from this site's side}}."""
        site = self.svc.site_details._site(site_id)
        elements, _ = _safe(lambda: self.svc.elements()[1])
        elements = elements or []
        element_ids = {e["id"] for e in elements if e.get("site_id") == site_id}
        with pool() as ex:
            f_cleared = ex.submit(_safe, self.svc.cache.get, ("cleared", site_id), config.ALARM_HISTORY_CACHE_S,
                                  lambda: alarms.history(self.svc.client, site_id, element_ids))
            standing, active_error = _safe(self.svc.standing_alarms)
            cleared, cleared_error = f_cleared.result()
        active = [a for a in alarms.place(standing or [], elements) if a.get("site_id") == site_id]
        return {
            "generated_at": now_iso(),
            "active": active, "active_error": active_error,
            "cleared": cleared, "cleared_error": cleared_error,
            "link_names": self._link_names(active, cleared, site.get("name")),
        }

    def _link_names(self, active, cleared, site_name):
        """Names for the link alarms' links (the topology is fetched only when there are some)."""
        wanted = {}
        for a in [*active, *(c for a in active for c in a.get("causes") or []), *(cleared or {}).get("rows", [])]:
            if a.get("entity_type") in LINK_ENTITIES:
                wanted[a["entity_id"]] = [a["entity_id"], *((a.get("info") or {}).get("vpnlinks") or [])]
        if not wanted:
            return {}
        names = self.topology_names(set(wanted))
        out = {}
        for link_id, ids in wanted.items():
            name = next((n for i in ids if (n := topology.name_for(names, i, site_name))), None)
            if name:
                out[link_id] = name
        return out

    def topology_names(self, ids):
        """The tenant's link names: cached TOPOLOGY_CACHE_S, fetched sooner (at most every
        TOPOLOGY_RETRY_S) while a link is unknown, e.g. a new one. A failure keeps the last names."""
        t = self._topology
        now = self._clock()
        with self._lock:
            names = t["names"]
            due = names is None or now - t["at"] >= config.TOPOLOGY_CACHE_S or not ids <= names.keys()
            if not due or now - t["tried"] < config.TOPOLOGY_RETRY_S:
                return names or {}
            t["tried"] = now
        try:
            site_names = {st["id"]: st.get("name") for st in self.svc.sites()}
            fresh = topology.link_names(topology.fetch(self.svc.client), site_names)
        except (ApiError, CacheError):
            return names or {}
        with self._lock:
            t.update(names=fresh, at=now)
        return fresh

    def share_topology(self, names):
        """Link names from a topology fetched elsewhere (the Overview's Map), so link alarms and
        health need no call of their own."""
        with self._lock:
            self._topology.update(names=names, at=self._clock())

    def forget(self, site_id):
        """The site left memory (Site details eviction)."""
        self.svc.cache.discard(("health", site_id))
        self.svc.cache.discard(("cleared", site_id))
