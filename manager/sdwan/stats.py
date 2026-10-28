"""Circuit statistics from 1-minute series: latest / p95 / peak / average, utilization and spikes.

A series here is a list of (epoch minute, value) sorted oldest first. Times in the output are API
timestamps (the start of the minute).
"""
import math

from .. import config
from ..timeutil import minute_iso, pct

LQM_KEYS = ("latency", "jitter_down", "jitter_up", "loss_down", "loss_up")
BANDWIDTH_KEYS = ("bw_down", "bw_up")
METRIC_KEYS = LQM_KEYS + BANDWIDTH_KEYS


def summarize(points):
    """{latest, latest_time, p95, peak, peak_time, avg}. p95 is the nearest-rank 95th percentile;
    the peak is the first minute at the highest value."""
    if not points:
        return {"latest": None, "latest_time": None, "p95": None, "peak": None, "peak_time": None, "avg": None}
    values = [v for _, v in points]
    ordered = sorted(values)
    peak_minute, peak = max(points, key=lambda mv: mv[1])
    return {
        "latest": round(points[-1][1], 3),
        "latest_time": minute_iso(points[-1][0]),
        "p95": round(ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)], 3),
        "peak": round(peak, 3),
        "peak_time": minute_iso(peak_minute),
        "avg": round(sum(values) / len(values), 3),
    }


def median(values):
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def spikes(points, ratio, over):
    """Minutes at or above max(ratio x median, median + over), merged when under SPIKE_GAP apart:
    {median, threshold, count, events}; events newest first (at most SPIKES_KEPT), each
    {start, end, minutes, peak, peak_time}."""
    if not points:
        return {"median": None, "threshold": None, "count": 0, "events": []}
    mid = median([v for _, v in points])
    threshold = max(ratio * mid, mid + over)
    gap = config.SPIKE_GAP.total_seconds() // config.STEP_SECONDS
    events = []
    for m, v in points:
        if v < threshold:
            continue
        if events and m - events[-1]["end"] <= gap:
            e = events[-1]
            e["end"], e["minutes"] = m, e["minutes"] + 1
            if v > e["peak"]:
                e["peak"], e["peak_time"] = v, m
        else:
            events.append({"start": m, "end": m, "minutes": 1, "peak": v, "peak_time": m})
    shown = [{"start": minute_iso(e["start"]), "end": minute_iso(e["end"]), "minutes": e["minutes"],
              "peak": round(e["peak"], 3), "peak_time": minute_iso(e["peak_time"])}
             for e in events[::-1][:config.SPIKES_KEPT]]
    return {"median": round(mid, 3), "threshold": round(threshold, 3), "count": len(events), "events": shown}


def circuit_metrics(series, capacity):
    """Every metric's figures for one circuit. series: {metric key: sorted [(minute, value)]} over the
    period; capacity: {"bw_down": Mbps, "bw_up": Mbps} (None when not configured)."""
    out = {}
    for key in METRIC_KEYS:
        points = series.get(key) or []
        st = summarize(points)
        if key in BANDWIDTH_KEYS:
            cap = capacity.get(key)
            st["latest_pct"], st["p95_pct"], st["peak_pct"] = pct(st["latest"], cap), pct(st["p95"], cap), pct(st["peak"], cap)
            # Mbps x 60 s per minute / 8 bits / 1000 MB per GB
            st["volume_gb"] = round(sum(v for _, v in points) * config.STEP_SECONDS / 8 / 1000, 2) if points else None
        if key in config.SPIKE_RULES:
            st["spikes"] = spikes(points, *config.SPIKE_RULES[key])
        out[key] = st
    return out
