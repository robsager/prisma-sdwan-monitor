"""Flask app: pages, the JSON API and the localhost-only security guards."""
from flask import Flask, jsonify, request, send_from_directory

from . import config, ion_monitor as ion_log, store
from .api.cache import CacheError
from .api.client import ApiError
from .flow_search import UnknownJob
from .sdwan.flows import SearchError
from .secret_store import SecretMissing
from .site_details import UnknownSite
from .tenant import Registry, UnknownTenant

# Pages load scripts, styles and data only from this server (Alpine.js is vendored), so a script
# can't send data or credentials elsewhere. Alpine evaluates its attribute expressions, hence
# 'unsafe-eval'; there are no inline scripts or styles.
CSP = ("default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
CSRF_HEADER = ("X-Requested-With", "sdwan-dashboard")


def create_app(registry: Registry | None = None, allowed_hosts: set[str] | None = None) -> Flask:
    app = Flask(__name__, static_folder=f"{config.APP_DIR}/static", static_url_path="/static")
    registry = registry or Registry()
    hosts = allowed_hosts or {f"127.0.0.1:{config.PORT}", f"localhost:{config.PORT}"}
    app.config["registry"] = registry

    @app.before_request
    def guard_local_requests():
        # A foreign Host header means DNS rebinding; every mutating call must carry a custom header
        # that a cross-origin page can't set without a CORS preflight (never approved).
        if request.host not in hosts:
            return jsonify({"error": "forbidden host"}), 403
        if request.method in ("POST", "PUT", "DELETE") and request.headers.get(CSRF_HEADER[0]) != CSRF_HEADER[1]:
            return jsonify({"error": f"missing {CSRF_HEADER[0]} header"}), 403

    @app.after_request
    def security_headers(resp):
        resp.headers["Content-Security-Policy"] = CSP
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    # ---- errors ---------------------------------------------------------------------------------

    @app.errorhandler(ApiError)
    def api_error(e):
        return jsonify({"error": str(e)}), e.status if e.status in (400, 401, 403, 404) else 502

    @app.errorhandler(CacheError)
    def cache_error(e):
        return jsonify({"error": str(e)}), 502

    @app.errorhandler(SecretMissing)
    def secret_missing(e):
        return jsonify({"error": str(e)}), 409

    @app.errorhandler(UnknownTenant)
    def unknown_tenant(e):
        return jsonify({"error": f"Unknown tenant {e}"}), 404

    @app.errorhandler(BadRequest)
    def bad_request(e):
        return jsonify({"error": str(e)}), 400

    @app.errorhandler(SearchError)
    def search_error(e):
        return jsonify({"error": str(e)}), 400

    @app.errorhandler(UnknownJob)
    def unknown_job(e):
        return jsonify({"error": "Unknown or expired search job."}), 404

    @app.errorhandler(UnknownSite)
    def unknown_site(e):
        return jsonify({"error": f"No site {e} in this tenant"}), 404

    # ---- pages ----------------------------------------------------------------------------------

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/flows")
    def flows_page():
        return send_from_directory(app.static_folder, "flows.html")

    @app.get("/api/version")
    def version():
        return jsonify({"version": config.VERSION})

    # ---- tenants --------------------------------------------------------------------------------

    @app.get("/api/tenants")
    def tenants_list():
        return jsonify(store.list_tenants())

    @app.post("/api/tenants")
    def tenants_upsert():
        body = request.get_json(silent=True) or {}
        tsg_id = str(body.get("tsg_id", "")).strip()
        try:
            tenant = store.upsert_tenant(
                tsg_id, str(body.get("name", "")).strip(), str(body.get("client_id", "")).strip(),
                str(body.get("client_secret", "")).strip() or None, bool(body.get("exclude_dc", True)))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        registry.drop(tsg_id)  # new credentials or settings: start over
        return jsonify(tenant)

    @app.delete("/api/tenants/<tsg_id>")
    def tenants_delete(tsg_id):
        registry.drop(tsg_id)
        if not store.delete_tenant(tsg_id):
            return jsonify({"error": "not found"}), 404
        ion_log.forget(tsg_id)
        return jsonify({"ok": True})

    @app.post("/api/tenants/<tsg_id>/test")
    def tenants_test(tsg_id):
        client = registry.fresh_client(tsg_id)
        try:
            return jsonify(client.test())
        finally:
            client.close()

    # ---- data -----------------------------------------------------------------------------------

    @app.get("/api/tenants/<tsg_id>/overview")
    def tenant_overview(tsg_id):
        """Every site, summarized (tenant-wide calls only; cached, kept fresh by the warmer)."""
        return jsonify(registry.get(tsg_id).overview(store.get_exclude_dc(tsg_id)))

    @app.get("/api/tenants/<tsg_id>/health")
    def tenant_health(tsg_id):
        """AIOps health of every site, app and link (good / fair / poor), last 3 h (polled every 5 minutes)."""
        return jsonify(registry.get(tsg_id).health())

    @app.get("/api/tenants/<tsg_id>/health/detail")
    def tenant_health_detail(tsg_id):
        """The fair and poor sites, apps and links: AIOps' 5-minute categories, and for links the
        Manager's estimate of the cause from their quality (asked for when Health issues is opened)."""
        return jsonify(registry.get(tsg_id).health_detail())

    @app.get("/api/tenants/<tsg_id>/topology")
    def tenant_topology(tsg_id):
        """The Overview's Map: every site and the VPN links between them with their state (one
        tenant-wide topology call, polled every 60 s while the Map is shown)."""
        return jsonify(registry.get(tsg_id).topology_map())

    @app.get("/api/tenants/<tsg_id>/apps")
    def tenant_apps(tsg_id):
        """Every app across the Overview's sites, last 24 h, from a background job (started by this
        call when the list is 10 minutes old). "status": "running" means poll again shortly."""
        return jsonify(registry.get(tsg_id).tenant_apps(store.get_exclude_dc(tsg_id)))

    @app.get("/api/tenants/<tsg_id>/apps/<app_id>/sites")
    def tenant_app_sites(tsg_id, app_id):
        """One app of the list per site, last 24 h: where it fails (a background job, one query per
        10 sites, kept 10 minutes). "status": "running" means poll again shortly."""
        if not app_id.isdigit():
            raise BadRequest("invalid app id")
        return jsonify(registry.get(tsg_id).app_sites(app_id, store.get_exclude_dc(tsg_id)))

    @app.get("/api/tenants/<tsg_id>/devices")
    def tenant_devices(tsg_id):
        """ION connected / disconnected status for every site (polled every 20 s)."""
        return jsonify(registry.get(tsg_id).devices())

    # ---- ION Connectivity Monitor ---------------------------------------------------------------

    @app.get("/api/tenants/<tsg_id>/ion-monitor")
    def ion_monitor_poll(tsg_id):
        """The log of IONs going offline and coming back: events new or updated since ?since=<rev>
        (all of them for 0 or another ?log), the watched serials' status. Polling keeps the watcher
        running; ?watch=1 makes it check every 5 s (Watch IONs). ?wait=<s>: when nothing changed, the
        answer waits up to that long (at most MONITOR_WAIT_S) and comes the moment an event is logged."""
        raw = request.args.get("since", "0")
        if not raw.isdigit():
            raise BadRequest("since must be a whole number.")
        wait = request.args.get("wait", "0")
        if not wait.isdigit():
            raise BadRequest("wait must be a whole number of seconds.")
        return jsonify(registry.get(tsg_id).ion_monitor.poll(int(raw), request.args.get("log"),
                                                            request.args.get("watch") == "1",
                                                            min(int(wait), config.MONITOR_WAIT_S)))

    @app.put("/api/tenants/<tsg_id>/ion-monitor/serials")
    def ion_monitor_serials(tsg_id):
        """{serials: [...]}: serial numbers to watch through the tenant's machines list (claimed or not)."""
        serials = (request.get_json(silent=True) or {}).get("serials")
        if not isinstance(serials, list):
            raise BadRequest("serials must be a list")
        try:
            return jsonify(registry.get(tsg_id).ion_monitor.set_serials(serials))
        except ValueError as e:
            raise BadRequest(str(e)) from e

    @app.delete("/api/tenants/<tsg_id>/ion-monitor/events")
    def ion_monitor_clear(tsg_id):
        return jsonify(registry.get(tsg_id).ion_monitor.clear())

    def window_hours():
        """?window=1h|4h|12h|24h (Site details' period), default 24."""
        raw = request.args.get("window", "24h").removesuffix("h")
        if not raw.isdigit() or int(raw) not in config.SITE_WINDOWS_H:
            raise BadRequest("invalid window")
        return int(raw)

    @app.get("/api/tenants/<tsg_id>/sites/<site_id>/detail")
    def site_detail(tsg_id, site_id):
        """One site's devices and circuits, with every metric's figures over ?window (opens the site
        for live updates)."""
        return jsonify(registry.get(tsg_id).site_detail(site_id, window_hours()))

    @app.get("/api/tenants/<tsg_id>/sites/<site_id>/live")
    def site_live(tsg_id, site_id):
        """The newest minutes and every metric's figures over ?window for an open site's circuits."""
        return jsonify(registry.get(tsg_id).site_live(site_id, window_hours()))

    @app.get("/api/tenants/<tsg_id>/sites/<site_id>/device-health")
    def site_device_health(tsg_id, site_id):
        """The site's IONs: CPU, memory, disk, temperatures, uptime, HA role (polled every 2 minutes)."""
        return jsonify(registry.get(tsg_id).site_device_health(site_id))

    @app.get("/api/tenants/<tsg_id>/sites/<site_id>/alarms")
    def site_alarms(tsg_id, site_id):
        """The site's active alarms and those cleared in the last 24 h, with link names."""
        return jsonify(registry.get(tsg_id).site_alarms(site_id))

    @app.get("/api/tenants/<tsg_id>/sites/<site_id>/probes")
    def site_probes(tsg_id, site_id):
        """Probe results per probe, circuit and path, with SLA limits and the tunnels' LQM, for every
        period of the selector (polled every 5 minutes while the Probes section is open)."""
        return jsonify(registry.get(tsg_id).site_probes(site_id))

    @app.get("/api/tenants/<tsg_id>/sites/<site_id>/top-apps")
    def site_top_apps(tsg_id, site_id):
        """Every app at the site over ?window, from the tenant's background job (started or refreshed
        by this call when needed). "status": "running" means poll again shortly."""
        return jsonify(registry.get(tsg_id).site_top_apps(site_id, window_hours()))

    @app.post("/api/tenants/<tsg_id>/sites/<site_id>/top-apps/<action>")
    def site_top_apps_action(tsg_id, site_id, action):
        """rtt | unreachable: "Load RTT" / "Load app unreachable" (one query per app, kept with every
        refresh after); refresh: "Refresh now" (at most once a minute). Poll top-apps for the result."""
        top = registry.get(tsg_id).top_apps
        if action == "refresh":
            return jsonify(top.refresh_now(site_id, window_hours()))
        if action not in ("rtt", "unreachable"):
            raise BadRequest("unknown action")
        return jsonify(top.load(site_id, window_hours(), action))

    @app.get("/api/tenants/<tsg_id>/sites/<site_id>/apps/<app_id>")
    def site_app_detail(tsg_id, site_id, app_id):
        """One app at the site over ?window: response times, failed-transaction rate, app unreachable
        and destination prefixes (two queries, cached 10 minutes)."""
        if not app_id.isdigit():
            raise BadRequest("invalid app id")
        return jsonify(registry.get(tsg_id).top_apps.detail(site_id, app_id, window_hours()))

    # ---- Flow Search ----------------------------------------------------------------------------

    @app.get("/api/tenants/<tsg_id>/flows/sites")
    def flow_sites(tsg_id):
        """Sites the search form lists: active, not data centers."""
        return jsonify({"sites": registry.get(tsg_id).flow_search.sites()})

    @app.get("/api/tenants/<tsg_id>/flows/apps")
    def flow_apps(tsg_id):
        return jsonify({"apps": registry.get(tsg_id).flow_search.apps()})

    @app.get("/api/tenants/<tsg_id>/flows/paths")
    def flow_paths(tsg_id):
        """path id -> name, for the Path column."""
        return jsonify(registry.get(tsg_id).flow_search.paths())

    @app.get("/api/tenants/<tsg_id>/flows/policies")
    def flow_policies(tsg_id):
        """Path, QoS and security policy rule names, and the probe behind each app's Move Flows rule."""
        return jsonify(registry.get(tsg_id).flow_search.policies())

    @app.post("/api/tenants/<tsg_id>/flows/search")
    def flow_search_start(tsg_id):
        """Start a search job: {site_ids, start_time, end_time, app_ids, ip_address, ip_mode, dest_ports,
        protocol}. Poll /flows/search/<job_id>?since=<next> for its flows as they arrive."""
        return jsonify(registry.get(tsg_id).flow_search.start(request.get_json(silent=True) or {}))

    @app.get("/api/tenants/<tsg_id>/flows/search/<job_id>")
    def flow_search_poll(tsg_id, job_id):
        raw = request.args.get("since", "0")
        if not raw.isdigit():
            raise BadRequest("since must be a whole number.")
        return jsonify(registry.get(tsg_id).flow_search.poll(job_id, int(raw)))

    @app.post("/api/tenants/<tsg_id>/flows/search/<job_id>/<action>")
    def flow_search_action(tsg_id, job_id, action):
        """stop: fetch no more pages (the flows so far stay); resume: keep going after the soft cap."""
        fs = registry.get(tsg_id).flow_search
        if action == "stop":
            return jsonify(fs.stop(job_id))
        if action == "resume":
            return jsonify(fs.resume(job_id))
        raise BadRequest("unknown action")

    return app


class BadRequest(Exception):
    pass
