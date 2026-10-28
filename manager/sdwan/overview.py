"""The Overview: every site, summarized, from tenant-wide calls only.

Scales to hundreds of sites: sites, devices, all WAN circuits (one query) and active alarms are
tenant-wide calls; current utilization is batched 10 circuits per query per direction. Nothing here
is per site or per circuit.
"""
from .. import config
from ..timeutil import minute_floor, num, pct
from .devices import devices_by_site
from .metrics import DIRECTIONS, bandwidth_points


def is_data_center(site):
    return site.get("element_cluster_role") == "HUB"


def latest_utilization(client, circuits, run):
    """({wid: {"down": {...}, "up": {...}}}, error): each circuit's newest 1-minute utilization in
    the last LIVE_LOOKBACK. run(fn, *args) runs fn concurrently (a thread pool's submit)."""
    end = minute_floor()
    start = end - config.LIVE_LOOKBACK
    batches = [circuits[i:i + config.METRICS_BATCH] for i in range(0, len(circuits), config.METRICS_BATCH)]
    jobs = [(batch, d) for batch in batches for d in DIRECTIONS]
    futures = [run(bandwidth_points, client, batch, d, start, end) for batch, d in jobs]
    values, errors = {}, []
    for (batch, direction), fut in zip(jobs, futures):
        points_by_wid, err = fut.result()
        if err:
            errors.append(err)
            continue
        key = DIRECTIONS[direction]
        for w in batch:
            points = points_by_wid.get(w["id"]) or []
            capacity = num(w.get("link_bw_down" if key == "down" else "link_bw_up"))
            t, v = points[-1] if points else (None, None)
            values.setdefault(w["id"], {})[key] = {
                "latest": round(v, 3) if v is not None else None,
                "latest_time": t,
                "latest_pct": pct(v, capacity),
            }
    return values, (errors[0] if errors else None)


def assemble(sites, elements, wanifs, alarms, wannets, utilization, exclude_dc):
    """The Overview's sites from the raw tenant-wide lists (pure: no API calls)."""
    shown = sorted((s for s in sites if not (exclude_dc and is_data_center(s))),
                   key=lambda s: (s.get("name") or "").lower())
    site_ids = {s["id"] for s in shown}
    net_name = {n["id"]: n.get("name") for n in wannets}
    devices = devices_by_site(elements)
    circuits, site_alarms = {}, {}
    for w in wanifs:
        if w.get("site_id") not in site_ids:
            continue
        u = utilization.get(w["id"], {})
        circuits.setdefault(w["site_id"], []).append({
            "id": w["id"],
            "name": w.get("name") or net_name.get(w.get("network_id")) or w["id"],
            "bw_down_mbps": num(w.get("link_bw_down")),
            "bw_up_mbps": num(w.get("link_bw_up")),
            "down": u.get("down"), "up": u.get("up"),
        })
    for a in alarms:
        if a.get("site_id") in site_ids:
            site_alarms.setdefault(a["site_id"], []).append(a)
    out = []
    for s in shown:
        addr = s.get("address") or {}
        out.append({
            "id": s["id"], "name": s.get("name") or s["id"], "role": s.get("element_cluster_role"),
            "branch_gateway": bool(s.get("branch_gateway")),
            "admin_state": s.get("admin_state"), "city": addr.get("city"), "country": addr.get("country"),
            "devices": devices.get(s["id"], []),
            "circuits": sorted(circuits.get(s["id"], []), key=lambda c: (c["name"] or "").lower()),
            "alarms": site_alarms.get(s["id"], []),
        })
    return out
