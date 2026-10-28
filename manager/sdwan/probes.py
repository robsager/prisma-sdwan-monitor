"""Probes: which probes run on which paths, their queries, and the Move Flows SLA limits.

Verified live with 1.x: a circuit runs the probe configs of its probe profile (the circuit's own
probe_profile_id, else its label's); each config's endpoints say whether it probes over VPN, direct
internet or both. monitor/metrics/probes takes one probe config and one path per query (the path is
a vpnlink id for VPN, the waninterface id for direct). A fabric link has a vpnlink per data center
ION; only the active one carries traffic (vpnlinks/{id}/status). The tunnel's own latency is
LqmLatency with filter.path = the vpnlink id and view individual "path" (the circuit-level LQM averages
every tunnel); its jitter, loss and MOS take the same filter with view individual "direction".
filter.site must be the branch end of the tunnel, whichever end the topology calls the source: the
data center end returns no points (live check 2026-10-27, 3 tenants).
"""
from ..config import V
from ..timeutil import iso, minute_iso, minute_of
from .health import LINK_METRICS, link_quality_body, parse_link_quality
from .metrics import LQM, iter_series, series_points
from .stats import summarize

PROBE_METRICS = [{"name": "ProbeLatency", "statistics": ["average"], "unit": "milliseconds"},
                 {"name": "ProbeJitter", "statistics": ["average"], "unit": "milliseconds"}]


def site_links(resp, site_id):
    """[(local waninterface id, far end name, [vpnlink ids])] for the site's fabric links that are up,
    from POST topology {"type": "anynet", "nodes": [site]} (either end may be this site)."""
    out = []
    for link in resp.get("links") or []:
        if link.get("status") != "up" or not link.get("vpnlinks"):
            continue
        if link.get("source_node_id") == site_id:
            local, far = "source", "target"
        elif link.get("target_node_id") == site_id:
            local, far = "target", "source"
        else:
            continue
        site, circuit = link.get(f"{far}_site_name") or "?", link.get(f"{far}_circuit_name")
        out.append((link.get(f"{local}_wan_if_id"), f"{site} ({circuit})" if circuit and circuit != site else site,
                    link["vpnlinks"]))
    return out


def circuit_probes(wanifs, labels, profiles, configs):
    """[(circuit, probe config id, path types)] for each enabled probe config a circuit runs, in
    circuit order. labels / profiles / configs: by id."""
    out = []
    for w in sorted(wanifs, key=lambda w: (w.get("name") or "").lower()):
        profile_id = w.get("probe_profile_id") or (labels.get(w.get("label_id")) or {}).get("probe_profile_id")
        for cid in (profiles.get(profile_id) or {}).get("probe_config_ids") or []:
            cfg = configs.get(cid)
            if cfg and cfg.get("enabled") is not False:
                out.append((w, cid, {t for e in cfg.get("endpoints") or [] for t in e.get("path_types") or []}))
    return out


def probe_paths(runs, vpn):
    """(paths, order): paths = {(probe config id, path id): {circuit, kind, name}} in circuit order,
    order = probe config ids in first-seen order. runs: circuit_probes(); vpn: waninterface id ->
    [(active vpnlink id, far end name)]."""
    paths, order = {}, []
    for w, cid, types in runs:
        found = [(w["id"], "direct", "Direct internet")] if "direct" in types else []
        if "vpn" in types:
            found += [(v, "vpn", name) for v, name in vpn.get(w["id"], [])]
        for path_id, kind, name in found:
            paths.setdefault((cid, path_id), {"circuit": w.get("name") or w["id"], "kind": kind, "name": name})
        if cid not in order:
            order.append(cid)
    return paths, order


def probe_body(site_id, config_id, path_id, start, end):
    return {"start_time": iso(start), "end_time": iso(end), "interval": "1min", "metrics": PROBE_METRICS,
            "filter": {"site": [site_id], "path": [path_id], "probe_config": [config_id]},
            "view": {"summary": False, "individual": "path"}}


def _by_hours(points, end_minute, hours, figures):
    """{"<h>": figures(points of the last h hours)} for each period; points: [(minute, value)], oldest first."""
    return {str(h): figures([(m, v) for m, v in points if m >= end_minute - h * 60]) for h in hours}


def probe_figures(resp, end_minute, hours):
    """{minutes, by_hours: {"<h>": {latest, latest_time, avg, p95, max, max_time, jitter, minutes}}} of
    one probe on one path; {"minutes": 0} without results."""
    series = {str(s.get("name", "")).lower(): series_points(s) for s in iter_series(resp)}
    latency = [(minute_of(t), v) for t, v in series.get("probelatency") or []]
    jitter = [(minute_of(t), v) for t, v in series.get("probejitter") or []]
    if not latency:
        return {"minutes": 0}

    def figures(points):
        if not points:
            return {"minutes": 0}
        st = summarize(points)
        j = [v for m, v in jitter if m >= points[0][0]]
        return {"latest": st["latest"], "latest_time": st["latest_time"], "avg": st["avg"], "p95": st["p95"],
                "max": st["peak"], "max_time": st["peak_time"], "minutes": len(points),
                "jitter": round(sum(j) / len(j), 3) if j else None}
    return {"minutes": len(latency), "by_hours": _by_hours(latency, end_minute, hours, figures)}


def tunnel_body(site_id, path_id, start, end):
    return {"start_time": iso(start), "end_time": iso(end), "interval": "1min", "metrics": [LQM["latency"]],
            "filter": {"site": [site_id], "path": [path_id]}, "view": {"individual": "path", "summary": False}}


def tunnel_latency(resp, end_minute, hours):
    """{"<h>": {avg, latest, p95, max, max_time, as_of, stale}} of the tunnel's latency over each period;
    a period without any: the newest hour that had some (stale: True). None without any points."""
    points = sorted((minute_of(t), v) for s in iter_series(resp) for t, v in series_points(s))
    if not points:
        return None
    as_of = minute_iso(points[-1][0])
    newest_hour = [(m, v) for m, v in points if m >= points[-1][0] - 60]

    def figures(recent):
        st = summarize(recent or newest_hour)
        return {"avg": round(st["avg"], 1), "latest": round(st["latest"], 1), "p95": round(st["p95"], 1),
                "max": round(st["peak"], 1), "max_time": st["peak_time"], "as_of": as_of, "stale": not recent}
    return _by_hours(points, end_minute, hours, figures)


def tunnel_quality_body(site_id, path_id, start, end):
    """The tunnel's jitter, loss and MOS each way (site: the branch end), 1-minute points."""
    _, metrics, view = LINK_METRICS[1]
    return link_quality_body(metrics, view, site_id, path_id, start, end, interval="1min")


def tunnel_quality(resp, end_minute, hours):
    """{"<h>": {jitter_in, jitter_out, loss_in, loss_out, mos_in, mos_out}}: averages over each period
    (in = into the branch), a key missing without points, None for a period without any; None
    without any points at all."""
    parsed = {k: sorted((minute_of(t), v) for t, v in series.items()) for k, series in parse_link_quality(resp, {}).items()}
    if not any(parsed.values()):
        return None

    def period(h):
        out = {}
        for key, points in parsed.items():
            vals = [v for m, v in points if m >= end_minute - h * 60]
            if vals:
                out[key] = round(sum(vals) / len(vals), 2)
        return out or None
    return {str(h): period(h) for h in hours}


def probe_target(cfg):
    """(protocol, target text, endpoints beyond the first) of a probe config."""
    endpoints = cfg.get("endpoints") or [{}]
    e = endpoints[0]
    proto = (e.get("protocol") or "").upper()
    target = f"{e.get('fqdn')} via {e.get('dns_server_ip')}" if proto == "DNS" else (e.get("fqdn") or e.get("ipv4_address") or "")
    return proto, target, max(0, len(endpoints) - 1)


def sla_limits(rules, threshold_profiles):
    """probe config id -> [{rule, limit}]: enabled Move Flows rules whose threshold profile sets a
    latency limit on that probe. From every policy set: a rule may not apply to this site."""
    out = {}
    for rule in rules:
        moves = any(str(a.get("action_type", "")).startswith("move_flows") for a in rule.get("actions") or [])
        if rule.get("enabled") is False or not moves:
            continue
        thresholds = (threshold_profiles.get(rule.get("thresholdprofile_id")) or {}).get("synthetic_probe_thresholds") or {}
        latency = thresholds.get("latency") or {}
        if latency.get("probe_config_id"):
            out.setdefault(latency["probe_config_id"], []).append({"rule": rule.get("name"), "limit": latency.get("value")})
    return out


def rules_path(policy_set_id):
    return f"/sdwan/{V.PERFRULES}/api/perfmgmtpolicysets/{policy_set_id}/perfmgmtpolicyrules"
