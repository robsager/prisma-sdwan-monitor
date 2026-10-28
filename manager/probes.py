"""Site details: tunnel LQM and probe results over the selected period (1, 4, 12 or 24 h).

A row per tunnel (the active vpnlink of each fabric link that is up) with its LQM, whether or not a
probe runs over it, and one entry per probe config in the open site's circuits' probe profiles, a row
per circuit and path: the tunnels (VPN) and direct internet. Per refresh (cached PROBES_CACHE_S, asked
for only while the Probes section is open): the site's fabric links (one topology call), each
tunnel's status, two LQM queries per tunnel (latency; jitter, loss and MOS) and one probe query per
probe config and path. A data center runs no probes and reports no LQM (each branch shows its own
tunnels to it), so it costs no calls at all. Probe profiles, configs and the Move Flows SLA limits are tenant config,
cached TENANT_CONFIG_CACHE_S; the circuits are the ones Site details already loaded.
"""
import threading
import time

from . import config
from .api.cache import CacheError
from .api.client import ApiError
from .api.pacing import pool
from .config import V
from .sdwan import probes
from .timeutil import minute_floor, minute_of, now_iso, iso


def _safe(fn, *args):
    try:
        return fn(*args), None
    except (ApiError, CacheError) as e:
        return None, str(e)


class Probes:
    """Probe results for one tenant. svc is its TenantService."""

    def __init__(self, svc, clock=time.time):
        self.svc = svc
        self._clock = clock
        self._lock = threading.Lock()
        self._slas_failed_at = None

    def results(self, site_id):
        """{generated_at, start, end, hours, hub, tunnels: [{id, circuit, name, latency?, quality?}],
        probes: [{id, name, protocol, target, extra_endpoints, slas, round_trips, paths: [{circuit,
        kind, name, path_id, minutes, by_hours?, error?, tunnel?}]}], error}. latency, quality,
        by_hours and tunnel are {"<h>": figures} for each period of the selector (hours)."""
        self.svc.site_details._site(site_id)  # UnknownSite
        return self.svc.cache.get(("probes", site_id), config.PROBES_CACHE_S, lambda: self._build(site_id))

    # ---- tenant config ----------------------------------------------------------------------------

    def _setup(self):
        """(probe profiles by id, probe configs by id)."""
        def by_id(path):
            return {x["id"]: x for x in self.svc.client.get_items(path)}
        profiles = self.svc.cache.get("probeprofiles", config.TENANT_CONFIG_CACHE_S,
                                      lambda: by_id(f"/sdwan/{V.PROBEPROFILES}/api/probeprofiles"))
        configs = self.svc.cache.get("probeconfigs", config.TENANT_CONFIG_CACHE_S,
                                     lambda: by_id(f"/sdwan/{V.PROBECONFIGS}/api/probeconfigs"))
        return profiles, configs

    def probe_configs(self):
        return self._setup()[1]

    def perf_policy(self):
        """(every performance policy rule, threshold profiles by id): what the SLA marks here and Flow
        Search's probe moves are read from. A failed fetch keeps the last ones (none at first) and is
        tried again after PROBE_SLAS_RETRY_S, not on every refresh."""
        with self._lock:
            failed_at = self._slas_failed_at
        if failed_at is not None and self._clock() - failed_at < config.PROBE_SLAS_RETRY_S:
            return self.svc.cache.peek("perf_policy") or ([], {})

        def fetch():
            client = self.svc.client
            thresholds = {x["id"]: x for x in client.get_items(f"/sdwan/{V.PERFTHRESHOLDS}/api/perfmgmtthresholdprofiles")}
            sets = client.get_items(f"/sdwan/{V.PERFSETS}/api/perfmgmtpolicysets")
            with pool() as ex:
                rules = [r for rs in ex.map(lambda ps: client.get_items(probes.rules_path(ps["id"])), sets) for r in rs]
            return rules, thresholds
        try:
            value = self.svc.cache.get("perf_policy", config.TENANT_CONFIG_CACHE_S, fetch)
        except (ApiError, CacheError):
            with self._lock:
                self._slas_failed_at = self._clock()
            return self.svc.cache.peek("perf_policy") or ([], {})
        with self._lock:
            self._slas_failed_at = None
        return value

    def _slas(self):
        """probe config id -> [{rule, limit}]."""
        return probes.sla_limits(*self.perf_policy())

    # ---- one refresh ------------------------------------------------------------------------------

    def _vpn_paths(self, site_id, circuits):
        """waninterface id -> [(active vpnlink id, far end name)] for the fabric links that are up on
        these circuits (only their tunnels' status is asked for)."""
        client = self.svc.client
        resp = client.request("POST", f"/sdwan/{V.TOPOLOGY}/api/topology", json={"type": "anynet", "nodes": [site_id]})
        links = [link for link in probes.site_links(resp, site_id) if link[0] in circuits]

        def active(vpnlink_id):
            try:
                return bool(client.request("GET", f"/sdwan/{V.VPNLINK_STATUS}/api/vpnlinks/{vpnlink_id}/status").get("active"))
            except ApiError:
                return False
        ids = [v for _, _, vs in links for v in vs]
        with pool() as ex:
            is_active = dict(zip(ids, ex.map(active, ids)))
        out = {}
        for wanif_id, name, vs in links:
            out.setdefault(wanif_id, []).extend((v, name) for v in vs if is_active.get(v))
        return out

    def _build(self, site_id):
        end = minute_floor()
        start = end - config.PROBE_WINDOW
        end_minute, hours = minute_of(end), list(config.SITE_WINDOWS_H)
        if self.svc.site_details._site(site_id).get("element_cluster_role") == "HUB":
            return {"generated_at": now_iso(), "start": iso(start), "end": iso(end), "hours": hours, "hub": True, "tunnels": [],
                    "probes": [], "error": None}
        self.svc.client.ensure_token()
        errors = []
        with pool() as ex:
            f_circuits = ex.submit(_safe, self.svc.site_details._circuits, site_id)
            f_labels = ex.submit(_safe, self.svc.wanlabels)
            f_nets = ex.submit(_safe, self.svc.wannetworks)
            f_setup = ex.submit(_safe, self._setup)
            f_elements = ex.submit(_safe, lambda: self.svc.elements()[1])
            circuits, circuits_error = f_circuits.result()
            setup, setup_error = f_setup.result()
            labels, _ = f_labels.result()
            elements, _ = f_elements.result()
            if setup_error:  # nothing to show without the probe configs
                raise ApiError(f"Probe configuration: {setup_error}")
            if circuits_error:
                raise ApiError(f"Circuits: {circuits_error}")
            profiles, configs = setup
            # Circuits named as in the circuits table: an unnamed one by its WAN network.
            nets = {n["id"]: n for n in f_nets.result()[0] or []}
            circuits = [{**w, "name": w.get("name") or nets.get(w.get("network_id"), {}).get("name") or w["id"]} for w in circuits or []]
            runs = probes.circuit_probes(circuits, {lb["id"]: lb for lb in labels or []}, profiles, configs)
            # A site without any ION has no tunnels and runs no probes: only the config is shown.
            no_ions = elements is not None and not any(e.get("site_id") == site_id for e in elements)
            vpn_circuits = {w["id"] for w in circuits}
            f_slas = ex.submit(self._slas) if runs else None  # the SLA marks only matter with probes to show
            vpn, vpn_error = {}, None
            if vpn_circuits and not no_ions:
                vpn, vpn_error = _safe(self._vpn_paths, site_id, vpn_circuits)
            slas = f_slas.result() if f_slas else {}
        if vpn_error:
            errors.append(f"Tunnels (fabric links) failed to load, so no tunnel LQM and only direct probe paths are shown: {vpn_error}")
        paths, order = probes.probe_paths(runs, vpn or {})
        tunnel_rows = [{"id": v, "circuit": w["name"], "name": name}
                       for w in sorted(circuits, key=lambda w: w["name"].lower()) for v, name in (vpn or {}).get(w["id"], [])]

        client = self.svc.client

        def probe(key):
            cid, path_id = key
            try:
                resp = client.request("POST", f"/sdwan/monitor/{V.PROBE_METRICS}/api/monitor/metrics/probes",
                                      json=probes.probe_body(site_id, cid, path_id, start, end))
            except ApiError as e:
                return {"error": str(e)}
            return probes.probe_figures(resp, end_minute, hours)

        def tunnel(path_id):
            try:
                resp = client.request("POST", f"/sdwan/monitor/{V.METRICS}/api/monitor/metrics",
                                      json=probes.tunnel_body(site_id, path_id, start, end))
            except ApiError:
                return None
            return probes.tunnel_latency(resp, end_minute, hours)

        def quality(path_id):
            try:
                resp = client.request("POST", f"/sdwan/monitor/{V.METRICS}/api/monitor/metrics",
                                      json=probes.tunnel_quality_body(site_id, path_id, start, end))
            except ApiError:
                return None
            return probes.tunnel_quality(resp, end_minute, hours)

        keys = [] if no_ions else list(paths)
        vpn_paths = sorted({p for (_, p), row in paths.items() if row["kind"] == "vpn"} | {t["id"] for t in tunnel_rows})
        listed = [t["id"] for t in tunnel_rows]
        # Probe queries and tunnel LQM go through different gates (probes, metrics): a pool for both.
        with pool(workers=config.ENDPOINT_CONCURRENCY["probes"] + config.ENDPOINT_CONCURRENCY["metrics"]) as ex:
            f_results = [ex.submit(probe, k) for k in keys]
            f_tunnels = [ex.submit(tunnel, p) for p in vpn_paths]
            f_quality = [ex.submit(quality, p) for p in listed]
            results = {k: f.result() for k, f in zip(keys, f_results)}
            tunnels = {p: f.result() for p, f in zip(vpn_paths, f_tunnels)}
            qualities = {p: f.result() for p, f in zip(listed, f_quality)}

        out = []
        for cid in order:
            cfg = configs[cid]
            proto, target, extra = probes.probe_target(cfg)
            rows = [{**row, "path_id": p, **results.get((c, p), {"minutes": 0}), **({"tunnel": tunnels.get(p)} if row["kind"] == "vpn" else {})}
                    for (c, p), row in paths.items() if c == cid]
            out.append({"id": cid, "name": cfg.get("name") or cid, "protocol": proto, "target": target,
                        "extra_endpoints": extra, "slas": slas.get(cid, []),
                        "round_trips": config.PROBE_ROUND_TRIPS.get(proto, 1), "paths": rows})
        tunnel_rows = [{**t, "latency": tunnels.get(t["id"]), "quality": qualities.get(t["id"])} for t in tunnel_rows]
        return {"generated_at": now_iso(), "start": iso(start), "end": iso(end), "hours": hours, "hub": False, "tunnels": tunnel_rows,
                "probes": out, "error": "; ".join(errors) or None}

    def forget(self, site_id):
        """The site left memory (Site details eviction)."""
        self.svc.cache.discard(("probes", site_id))
