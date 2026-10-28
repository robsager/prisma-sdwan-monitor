"""monitor/metrics queries and response parsing.

Verified live with 1.x (monitor/metrics v2.7): "unit" is required and case-sensitive; the finest
resolution is 1-minute points (a "10sec" interval returns the same points); filter.site /
filter.waninterface take at most 10 items; BandwidthUsage direction Ingress = download, Egress =
upload, queried separately (one query can't carry both, live check 2026-10-26).

Link quality (LQM) metrics take one circuit per query. LqmJitter and LqmPacketLoss need a direction
view; LqmLatency rejects any direction (there is no one-way latency) and only returns series with an
individual "waninterface" view, so it is a query of its own: two queries per circuit.
"""
from .. import config
from ..api.client import ApiError
from ..config import V
from ..timeutil import iso

BANDWIDTH = {"name": "BandwidthUsage", "statistics": ["average"], "unit": "Mbps"}
DIRECTIONS = {"Ingress": "down", "Egress": "up"}
LQM = {
    "latency": {"name": "LqmLatency", "statistics": ["average"], "unit": "milliseconds"},
    "jitter": {"name": "LqmJitter", "statistics": ["average"], "unit": "milliseconds"},
    "loss": {"name": "LqmPacketLoss", "statistics": ["average"], "unit": "Percentage"},
}
# (label for errors, metrics, view)
LQM_QUERIES = [
    ("latency", ["latency"], {"individual": "waninterface", "summary": False}),
    ("jitter/loss", ["jitter", "loss"], {"individual": "direction", "summary": False}),
]


def query_metrics(client, metrics, filt, view, start, end, interval="1min"):
    body = {"start_time": iso(start), "end_time": iso(end), "interval": interval,
            "metrics": metrics, "view": view, "filter": filt}
    return client.request("POST", f"/sdwan/monitor/{V.METRICS}/api/monitor/metrics", json=body)


def iter_series(obj):
    """Every series dict in a monitor response, whatever the nesting."""
    if isinstance(obj, dict):
        if isinstance(obj.get("series"), list):
            yield from (s for s in obj["series"] if isinstance(s, dict))
        for v in obj.values():
            if isinstance(v, (dict, list)):
                yield from iter_series(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from iter_series(v)


def series_points(series):
    """Non-null (time, value) datapoints, oldest first."""
    points = [(p.get("time") or "", p["value"])
              for d in series.get("data") or [] for p in d.get("datapoints") or []
              if isinstance(p.get("value"), (int, float))]
    return sorted(points, key=lambda tv: tv[0])


def bandwidth_points(client, circuits, direction, start, end):
    """({waninterface_id: [(time, Mbps), ...]}, error) for up to METRICS_BATCH circuits (dicts with
    id and site_id), one query."""
    assert len(circuits) <= config.METRICS_BATCH
    filt = {"site": sorted({c["site_id"] for c in circuits}), "waninterface": [c["id"] for c in circuits],
            "direction": direction}
    try:
        resp = query_metrics(client, [BANDWIDTH], filt, {"individual": "waninterface", "summary": False}, start, end)
    except ApiError as e:
        return {}, str(e)
    out = {}
    for s in iter_series(resp):
        wid = (s.get("view") or {}).get("waninterface_id")
        if wid:
            out[wid] = series_points(s)
    return out, None


def lqm_points(client, site_id, wanif_id, query, start, end):
    """({metric key: [(time, value), ...]}, error) for one LQM_QUERIES entry and one circuit. Keys:
    latency, jitter_down, jitter_up, loss_down, loss_up."""
    label, keys, view = query
    filt = {"site": [site_id], "waninterface": [wanif_id]}
    try:
        resp = query_metrics(client, [LQM[k] for k in keys], filt, view, start, end)
    except ApiError as e:
        return {}, f"{label}: {e}"
    key_of = {LQM[k]["name"].lower(): k for k in keys}
    out = {}
    for s in iter_series(resp):
        key = key_of.get(str(s.get("name", "")).lower())
        if not key:
            continue
        direction = str((s.get("view") or {}).get("direction", "")).lower()
        suffix = {"ingress": "_down", "egress": "_up"}.get(direction, "")
        out[key + suffix] = series_points(s)
    return out, None
