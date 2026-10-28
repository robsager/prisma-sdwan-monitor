"""One tenant's data service: shared caches, the Overview warmer, and the registry of tenants.

Every browser tab reads the same cached results. The warmer rebuilds the Overview in the background
every WARM_INTERVAL_S while someone has used the app in the last WARM_IDLE_S, so page polls are
served from the cache and an idle Manager makes no calls.
"""
import threading
import time
from datetime import datetime, timezone

from . import config, store
from .api.cache import SingleFlightCache
from .api.client import ApiClient, ApiError
from .api.pacing import pool, set_background
from .config import V
from .sdwan import alarms, overview, topology
from .sdwan.devices import devices_by_site
from .flow_search import FlowSearch
from .ion_monitor import IonMonitor
from .site_details import SiteDetails
from .probes import Probes
from .site_health import SiteHealth
from .tenant_panel import TenantPanel
from .top_apps import TopApps
from .timeutil import iso, now_iso


class UnknownTenant(Exception):
    pass


def measurable(circuits, elements):
    """The circuits worth a utilization query: at sites with an ION connected. A site whose IONs
    are all offline reports no traffic (live: 13 of 33 branch circuits), so asking costs metrics
    calls for nothing. All of them when the ION list failed to load."""
    if elements is None:
        return circuits
    online = {e.get("site_id") for e in elements if e.get("connected")}
    return [w for w in circuits if w.get("site_id") in online]


def _safe(fn, *args):
    """(result, None) or (None, error message) for an ApiError."""
    try:
        return fn(*args), None
    except ApiError as e:
        return None, str(e)


class TenantService:
    def __init__(self, client: ApiClient, clock=time.time):
        self.client = client
        self.tsg_id = client.tsg_id
        self.cache = SingleFlightCache(clock=clock)
        self._clock = clock
        self._util = None          # {"key", "at", "values"}: Overview utilization, reused OVERVIEW_BW_CACHE_S
        self._util_lock = threading.Lock()
        self._last_use = 0.0
        self._warm_exclude_dc = None
        self._warmer = None
        self._closed = False
        self.site_details = SiteDetails(self)
        self.site_health = SiteHealth(self, clock=clock)
        self.top_apps = TopApps(self, clock=clock)
        self.probes = Probes(self, clock=clock)
        self.tenant_panel = TenantPanel(self, clock=clock)
        self.flow_search = FlowSearch(self, clock=clock)
        self.ion_monitor = IonMonitor(self, clock=clock, autostart=clock is time.time)

    # ---- shared lists ---------------------------------------------------------------------------

    def sites(self):
        return self.cache.get("sites", config.SITES_CACHE_S,
                              lambda: self.client.get_items(f"/sdwan/{V.SITES}/api/sites"))

    def elements(self, max_age=config.ELEMENTS_CACHE_S):
        """(fetched_at iso, every ION in the tenant), at most max_age seconds old."""
        return self.cache.get("elements", max_age,
                              lambda: (now_iso(), self.client.get_items(f"/sdwan/{V.ELEMENTS}/api/elements")))

    def wannetworks(self):
        return self.cache.get("wannetworks", config.TENANT_CONFIG_CACHE_S,
                              lambda: self.client.get_items(f"/sdwan/{V.WANNET}/api/wannetworks"))

    def wanlabels(self):
        return self.cache.get("wanlabels", config.TENANT_CONFIG_CACHE_S,
                              lambda: self.client.get_items(f"/sdwan/{V.WANLABEL}/api/waninterfacelabels"))

    def standing_alarms(self):
        """Every active alarm in the tenant, nested (shared by the Overview and Site details)."""
        return self.cache.get("standing", config.STANDING_CACHE_S, lambda: alarms.standing_alarms(self.client))

    def tenant_wanifs(self):
        """(every site's WAN circuits, error): tenant-wide waninterfaces/query, WANIF_PAGE per page.
        The API returns at most 100 without a limit, so a bigger tenant needs dest_page (verified
        live: _offset is ignored). error when the pages stop short of total_count."""
        items = []
        for page in range(1, config.MAX_WANIF_PAGES + 1):
            body = {"limit": config.WANIF_PAGE, **({"dest_page": page} if page > 1 else {})}
            resp = self.client.request("POST", f"/sdwan/{V.WANIF}/api/waninterfaces/query", json=body)
            batch = resp.get("items") or []
            items += batch
            total = resp.get("total_count")
            if len(batch) < config.WANIF_PAGE or (isinstance(total, int) and len(items) >= total):
                break
        total = resp.get("total_count")
        if isinstance(total, int) and len(items) < total:
            return items, f"Only {len(items)} of {total} WAN circuits loaded"
        return items, None

    # ---- pages ----------------------------------------------------------------------------------

    def devices(self):
        """ION connectivity for every site (one call for the tenant). Raises ApiError, so the page
        keeps showing the last status."""
        fetched_at, elements = self.elements()
        return {"generated_at": fetched_at, "devices": devices_by_site(elements)}

    def overview(self, exclude_dc=True):
        exclude_dc = bool(exclude_dc)
        self._last_use = self._clock()
        self._warm_exclude_dc = exclude_dc
        self._ensure_warmer()
        return self.cache.get(("overview", exclude_dc), config.OVERVIEW_CACHE_S, lambda: self._build_overview(exclude_dc))

    def _build_overview(self, exclude_dc):
        self.client.ensure_token()
        with pool() as ex:
            f_sites = ex.submit(self.sites)
            f_elements = ex.submit(_safe, lambda: self.elements()[1])
            f_wanifs = ex.submit(_safe, self.tenant_wanifs)
            f_alarms = ex.submit(_safe, self.standing_alarms)
            f_nets = ex.submit(_safe, self.wannetworks)
            all_sites = f_sites.result()
            shown = {s["id"] for s in all_sites if not (exclude_dc and overview.is_data_center(s))}
            paged, wanifs_error = f_wanifs.result()
            wanifs, wanifs_error = paged or (None, wanifs_error)
            circuits = [w for w in wanifs or [] if w.get("site_id") in shown]
            elements, elements_error = f_elements.result()
            utilization, util_at, util_error = self._utilization(measurable(circuits, elements), ex.submit)
            standing, alarms_error = f_alarms.result()
            nets, _ = f_nets.result()
        standing = alarms.place(standing or [], elements or [])
        site_ids = {s["id"] for s in all_sites}
        return {
            "tsg_id": self.tsg_id,
            "tenant_name": self.client.tenant_name,
            "generated_at": now_iso(),
            # When utilization was fetched: the page judges "live" against this, not now, or a site
            # would read "Not live" for most of the cache period.
            "utilization_at": iso(datetime.fromtimestamp(util_at, timezone.utc)),
            "errors": [e for e in (wanifs_error, elements_error, alarms_error, util_error) if e],
            "site_filter": {"exclude_dc": exclude_dc, "total_sites": len(all_sites)},
            "sites": overview.assemble(all_sites, elements or [], circuits, standing, nets or [],
                                       utilization, exclude_dc),
            # Active alarms not at any site (e.g. a User-ID agent's), so the count is never quietly short,
            # and those left behind by deleted sites (live: 11, up to ~3 years old), counted apart.
            "unplaced_alarms": [a for a in standing if not a.get("site_id")],
            "deleted_site_alarms": [a for a in standing if a.get("site_id") and a["site_id"] not in site_ids],
        }

    def _utilization(self, circuits, run):
        """Latest utilization per circuit, reused for OVERVIEW_BW_CACHE_S while the circuit set is
        the same. (values, fetched_at epoch seconds, error)."""
        key = tuple(sorted(w["id"] for w in circuits))
        with self._util_lock:
            hit = self._util
            if hit and hit["key"] == key and self._clock() - hit["at"] < config.OVERVIEW_BW_CACHE_S:
                return hit["values"], hit["at"], None
        fetched_at = self._clock()
        values, error = overview.latest_utilization(self.client, circuits, run)
        if not error:
            with self._util_lock:
                self._util = {"key": key, "at": fetched_at, "values": values}
        return values, fetched_at, error

    def topology_map(self):
        """The Overview's Map: {generated_at, sites: [{id, name, role, branch_gateway, admin_state, city, country}]
        (every site, data centers too), links: topology.tunnels}. One tenant-wide topology call per
        TOPOLOGY_MAP_CACHE_S, whose link names also serve link alarms and AIOps health."""
        return self.cache.get("topology_map", config.TOPOLOGY_MAP_CACHE_S, self._build_topology_map)

    def _build_topology_map(self):
        sites = self.sites()
        resp = topology.fetch(self.client)
        self.site_health.share_topology(topology.link_names(resp, {s["id"]: s.get("name") for s in sites}))
        return {
            "generated_at": now_iso(),
            "sites": [{"id": s["id"], "name": s.get("name") or s["id"], "role": s.get("element_cluster_role"),
                       "branch_gateway": bool(s.get("branch_gateway")),
                       "admin_state": s.get("admin_state"), "city": (s.get("address") or {}).get("city"),
                       "country": (s.get("address") or {}).get("country")} for s in sites],
            "links": topology.tunnels(resp),
        }

    def site_detail(self, site_id, hours=24):
        return self.site_details.detail(site_id, hours)

    def site_live(self, site_id, hours=24):
        return self.site_details.live(site_id, hours)

    def site_device_health(self, site_id):
        return self.site_health.device_health(site_id)

    def site_alarms(self, site_id):
        return self.site_health.alarms(site_id)

    def site_top_apps(self, site_id, hours=24):
        return self.top_apps.snapshot(site_id, hours)

    def site_probes(self, site_id):
        return self.probes.results(site_id)

    def health(self):
        return self.tenant_panel.health()

    def health_detail(self):
        return self.tenant_panel.health_detail()

    def tenant_apps(self, exclude_dc=True):
        return self.tenant_panel.tenant_apps(exclude_dc)

    def app_sites(self, app_id, exclude_dc=True):
        return self.tenant_panel.app_sites(app_id, exclude_dc)

    def test(self):
        return self.client.test()

    # ---- background warmer ----------------------------------------------------------------------

    def _ensure_warmer(self):
        if self._closed or (self._warmer and self._warmer.is_alive()):
            return
        self._warmer = threading.Thread(target=self._warm_loop, daemon=True, name=f"warmer-{self.tsg_id}")
        self._warmer.start()

    def _idle(self):
        return self._clock() - self._last_use >= config.WARM_IDLE_S

    def _warm_loop(self):
        set_background(True)
        while not self._closed and not self._idle():
            time.sleep(config.WARM_INTERVAL_S)
            exclude_dc = self._warm_exclude_dc
            if self._closed or exclude_dc is None or self._idle():
                break
            try:
                self.cache.get(("overview", exclude_dc), 0, lambda: self._build_overview(exclude_dc), force=True)
            except Exception:  # noqa: BLE001 - the next cycle retries; pages keep the last result
                pass

    def close(self):
        """Stop background work (tenant edited or deleted), save open sites' series and release pooled
        connections."""
        self._closed = True
        self.ion_monitor.close()
        self.flow_search.close()
        self.site_details.close()
        self.client.close()


class Registry:
    """Live TenantService per TSG, created on first use from the stored credentials."""

    def __init__(self, make_client=ApiClient):
        self._make_client = make_client
        self._services = {}
        self._lock = threading.Lock()

    def get(self, tsg_id) -> TenantService:
        with self._lock:
            svc = self._services.get(tsg_id)
            if svc is None:
                creds = store.get_credentials(tsg_id)
                if creds is None:
                    raise UnknownTenant(tsg_id)
                svc = self._services[tsg_id] = TenantService(self._make_client(tsg_id, *creds))
            return svc

    def close_all(self):
        """Shutting down: save every tenant's open sites."""
        with self._lock:
            services, self._services = list(self._services.values()), {}
        for svc in services:
            svc.close()

    def drop(self, tsg_id):
        with self._lock:
            svc = self._services.pop(tsg_id, None)
        if svc is not None:
            svc.close()

    def fresh_client(self, tsg_id) -> ApiClient:
        """A throwaway client with the saved credentials (Test: a fresh sign-in without disturbing
        the tenant's live caches)."""
        creds = store.get_credentials(tsg_id)
        if creds is None:
            raise UnknownTenant(tsg_id)
        return self._make_client(tsg_id, *creds)
