"""ION devices (elements): connectivity for every site, and one site's device health."""
from datetime import datetime, timezone

from ..timeutil import iso, utc_ticks
from .metrics import iter_series, series_points


def ha_priority(element):
    """The configured branch HA priority, or None when the element isn't in an HA pair."""
    return (element.get("spoke_ha_config") or {}).get("priority") if ha_cluster(element) else None


def devices_by_site(elements):
    """{site_id: [device, ...]} sorted by name. "connected" = connected to the controller now.
    "updated" = the element record's last change: the controller rewrites it on every connect and
    disconnect (verified live), so a reconnect that "connected" never showed is still visible."""
    by_site = {}
    for e in elements:
        by_site.setdefault(e.get("site_id"), []).append({
            "id": e["id"],
            "name": e.get("name") or e.get("serial_number") or e["id"],
            "model": e.get("model_name"),
            "software": e.get("software_version"),
            "serial": e.get("serial_number"),
            "connected": bool(e.get("connected")),
            "updated": utc_ticks(e.get("_updated_on_utc")),
            "ha_priority": ha_priority(e),
        })
    for devices in by_site.values():
        devices.sort(key=lambda d: d["name"].lower())
    return by_site


# ---- device health ------------------------------------------------------------------------------
#
# monitor/sys_metrics (verified live with 1.x on 1200-S, 3200 and 9200, 6.5.3 and 6.8.1): 5-minute
# averages per element; filter.site is required. Per the API's own metric list, MemoryUsage is
# "Available memory" and DiskUsage "Available disk space" (DiskUsage reads 97-99.7% everywhere), so
# both are free space, not used. Temperatures depend on the model (CPU on all, inlet and outlet on
# larger ones). There are no fan or power supply metrics: those come as DEVICEHW_* alarms.

# sys_metrics name -> (key, unit)
SYS_METRICS = {
    "CPUUsage": ("cpu_pct", "percentage"),
    "MemoryUsage": ("memory_free_pct", "percentage"),
    "DiskUsage": ("disk_free_pct", "percentage"),
    "DeviceCpuTemperature": ("temp_cpu", "celsius"),
    "DeviceInletTemperature": ("temp_inlet", "celsius"),
    "DeviceOutletTemperature": ("temp_outlet", "celsius"),
}


def sys_metrics_body(site_id, element_ids, start, end):
    return {
        "start_time": iso(start), "end_time": iso(end), "interval": "5min",
        "view": {"summary": False, "individual": "element"},
        "filter": {"site": [site_id], "element": element_ids},
        "metrics": [{"name": name, "statistics": ["average"], "unit": unit} for name, (_, unit) in SYS_METRICS.items()],
    }


def parse_sys_metrics(resp):
    """{element_id: {cpu_pct, memory_free_pct, disk_free_pct, temps: {cpu, inlet, outlet}, metrics_time}}:
    each metric's newest 5-minute average in the response."""
    out = {}
    for series in iter_series(resp):
        key = SYS_METRICS.get(series.get("name"), (None,))[0]
        eid = (series.get("view") or {}).get("element_id")
        points = series_points(series)
        if not eid or not key or not points:
            continue
        d = out.setdefault(eid, {"temps": {}})
        t, v = points[-1]
        if key.startswith("temp_"):
            d["temps"][key[5:]] = round(v, 1)
        else:
            d[key] = round(v, 1)
        d["metrics_time"] = max(d.get("metrics_time") or "", t)
    return out


def element_status(st):
    """What the Devices table shows from elements/{id}/status. *_on_utc are 100 ns ticks,
    last_rebooted_time is seconds (both verified live)."""
    rebooted = st.get("last_rebooted_time")
    info = (st.get("last_rebooted_info") or "").strip()
    return {
        "connected_since": utc_ticks(st.get("config_and_events_connected_on_utc")),
        "disconnected_at": utc_ticks(st.get("config_and_events_disconnected_on_utc")),
        "last_reboot": iso(datetime.fromtimestamp(rebooted, timezone.utc)) if isinstance(rebooted, (int, float)) and rebooted > 0 else None,
        "last_reboot_info": info if info and info != "unknown" else None,
    }


def ha_cluster(element):
    """The element's branch HA cluster id, or None."""
    cfg = element.get("spoke_ha_config") or {}
    return cfg.get("cluster_id") if cfg.get("enable") and cfg.get("cluster_id") else None


def ha_status(st):
    """{element_id: {state, since, priority, peer_connected}} from a spoke cluster's status.
    cluster_members has each ION's role now ("active" / "backup"); switch_over_events has one entry
    per role change per ION (switch_over_time in ms) with cluster_events (time, effective_priority,
    peer_connected) inside: the latest of each is the current state (verified live with 1.x)."""
    out = {}
    for m in st.get("cluster_members") or []:
        eid = m.get("element_id")
        changes = [x for x in st.get("switch_over_events") or [] if x.get("element_id") == eid]
        last = max(changes, key=lambda x: x.get("switch_over_time") or 0, default={})
        events = [c for x in changes for c in x.get("cluster_events") or []]
        now = max(events, key=lambda c: c.get("time") or 0, default=last)
        since = last.get("switch_over_time")
        out[eid] = {
            "state": m.get("status"),
            "since": iso(datetime.fromtimestamp(since / 1000, timezone.utc)) if since else None,
            "priority": now.get("effective_priority"),
            "peer_connected": now.get("peer_connected"),
        }
    return out
