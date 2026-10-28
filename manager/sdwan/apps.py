"""Applications at a site: the app list (monitor/applicationstats), app names, and the per-app
queries (RTT, per-prefix events, response times and transactions).

Verified live with 1.x: applicationstats gives every app's volume, flows and failures for whole sites
in one query, but RTT, response times and per-prefix events take exactly one app per query (an app
filter is mandatory), and no endpoint ranks apps by RTT.
"""
from datetime import timedelta

from .. import config
from ..api.client import ApiError
from ..config import V
from ..timeutil import iso, minute_iso, minute_of
from .metrics import iter_series, query_metrics, series_points
from .stats import summarize

APPSTATS_METRICS = ["TrafficVolume", "TCPFlowCount", "UDPFlowCount", "AppFailedToEstablish", "AppTransactionFailures"]
MIB_TO_GB = 1.048576 / 1000  # TrafficVolume is in MiB (matches BandwidthUsage-derived GB within ~1%)
APPSTATS_FIELDS = {"down": "sum_value_ingress", "up": "sum_value_egress", "tcp": "tcp_flow_count_sum",
                   "udp": "udp_flow_count_sum", "conn": "app_failed_to_establish_sum", "txn": "app_transaction_failures_sum"}
RTT_METRIC = {"name": "AppRoundTripTime", "statistics": ["average"], "unit": "milliseconds"}
# Details: response times (one app per query; series only with view individual "app"). UDP TRT is
# reported by request/response UDP apps (DNS), not streaming ones. The transaction counts give the
# failed-txn rate; the counts in the table come from applicationstats (its total differs).
PERF_METRICS = [
    {"name": "AppServerResponseTime", "statistics": ["average"], "unit": "milliseconds"},
    RTT_METRIC,
    {"name": "AppUDPTransactionResponseTime", "statistics": ["average"], "unit": "milliseconds"},
    {"name": "AppTransactionFailures", "statistics": ["sum"], "unit": "count"},
    {"name": "AppTotalTransactions", "statistics": ["sum"], "unit": "count"},
]
APP_VIEW = {"individual": "app", "summary": False}


def app_names(client):
    """app id -> display name, from every app definition (~4,700, one call)."""
    return {a["id"]: a.get("display_name") or a.get("app_name") or a["id"]
            for a in client.get_items(f"/sdwan/{V.APPDEFS}/api/appdefs")}


def app_stats(client, site_ids, start, end):
    """Every app's counts at these sites over [start, end): app id -> {id, gb, gb_down, gb_up, flows,
    tcp_flows, failed_connections, failed_txn}.

    1-hour rows only cover hours that start inside the window (verified live), so a second query
    with 5-minute rows fills the start up to the first whole hour (1-minute rows overflow the
    response for a day): at most 4 minutes left out. App id "0" (unclassified traffic) is dropped.
    """
    first_hour = start.replace(minute=0, second=0, microsecond=0)
    if first_hour < start:
        first_hour += timedelta(hours=1)
    queries = [(start, end, "1hour")] + ([(start, first_hour, "5min")] if first_hour > start else [])
    acc = {}
    for q_start, q_end, interval in queries:
        resp = client.request("POST", f"/sdwan/monitor/{V.APPSTATS}/api/monitor/applicationstats/query", json={
            "start_time": iso(q_start), "end_time": iso(q_end), "interval": interval, "view": "app",
            "metrics": APPSTATS_METRICS, "filter": {"site": list(site_ids)},
        })
        for row in resp.get("response") or []:
            app_id = row.get("app_id")
            if not app_id or app_id == "0":
                continue
            t = acc.setdefault(app_id, dict.fromkeys(APPSTATS_FIELDS, 0.0))
            for k, f in APPSTATS_FIELDS.items():
                t[k] += row.get(f) or 0
    return {a: {"id": a, "gb": round((t["down"] + t["up"]) * MIB_TO_GB, 4),
                "gb_down": round(t["down"] * MIB_TO_GB, 4), "gb_up": round(t["up"] * MIB_TO_GB, 4),
                "flows": int(t["tcp"] + t["udp"]), "tcp_flows": int(t["tcp"]),
                "failed_connections": int(t["conn"]), "failed_txn": int(t["txn"])}
            for a, t in acc.items()}


SITE_METRICS = {"conn": "AppFailedToEstablish", "tcp": "TCPFlowCount", "udp": "UDPFlowCount", "txn": "AppTransactionFailures"}
SITE_VIEW = {"individual": "site", "summary": False}


def app_site_stats(client, app_id, site_ids, start, end):
    """One app's counts per site over [start, end): site id -> {flows, tcp_flows, failed_connections,
    failed_txn}, for up to METRICS_BATCH sites.

    applicationstats can't split by site (only view "app" adds a key; verified live), so this asks
    monitor/metrics for one series per site (the same counts as applicationstats per site, verified
    live; TrafficVolume isn't offered there, so no GB). Hours split as in app_stats.
    """
    assert len(site_ids) <= config.METRICS_BATCH
    first_hour = start.replace(minute=0, second=0, microsecond=0)
    if first_hour < start:
        first_hour += timedelta(hours=1)
    queries = [(start, end, "1hour")] + ([(start, first_hour, "5min")] if first_hour > start else [])
    metrics = [{"name": m, "statistics": ["sum"], "unit": "count"} for m in SITE_METRICS.values()]
    field = {m: k for k, m in SITE_METRICS.items()}
    acc = {s: dict.fromkeys(SITE_METRICS, 0.0) for s in site_ids}
    for q_start, q_end, interval in queries:
        resp = query_metrics(client, metrics, {"site": list(site_ids), "app": [app_id]}, SITE_VIEW, q_start, q_end, interval)
        for s in iter_series(resp):
            sid, k = (s.get("view") or {}).get("site_id"), field.get(s.get("name"))
            if sid in acc and k:
                acc[sid][k] += sum(v for _, v in series_points(s))
    return {s: {"flows": int(t["tcp"] + t["udp"]), "tcp_flows": int(t["tcp"]),
                "failed_connections": int(t["conn"]), "failed_txn": int(t["txn"])} for s, t in acc.items()}


def named_apps(stats, names):
    """The apps with traffic, named, most data first."""
    return sorted((dict(a, name=names.get(a["id"]) or a["id"]) for a in stats.values() if a["gb"] > 0 or a["flows"] > 0),
                  key=lambda a: (-a["gb"], -a["flows"]))


def candidates(apps, exclude_names=()):
    """App ids RTT and app unreachable are fetched for, in the list's order: the RTT_TOP_N with the
    most TCP flows, plus the TCP apps among the first RTT_TOP_DATA (apps is most data first)."""
    tcp = [a for a in apps if a.get("tcp_flows")]
    ids = [a["id"] for a in sorted(tcp, key=lambda a: -a["tcp_flows"])[:config.RTT_TOP_N]]
    ids += [a["id"] for a in apps[:config.RTT_TOP_DATA] if a.get("tcp_flows") and a["id"] not in ids]
    excluded = {a["id"] for a in apps if a.get("name") in exclude_names}
    return [i for i in ids if i not in excluded]


def _minute_points(series):
    return [(minute_of(t), v) for t, v in series_points(series)]


def _ms_stats(points):
    """{p95, avg, peak, peak_time, minutes} of 1-minute values, or None without any."""
    if not points:
        return None
    st = summarize(points)
    return {"p95": st["p95"], "avg": st["avg"], "peak": st["peak"], "peak_time": st["peak_time"], "minutes": len(points)}


def rtt_trend(points, end):
    """{trend, recent_avg, base_avg, recent_minutes}: the last TXN_RECENT against the rest of the
    period. trend is None when either side has too few minutes."""
    split = minute_of(end - config.TXN_RECENT)
    recent = [v for m, v in points if m >= split]
    base = [v for m, v in points if m < split]
    out = {"trend": None, "recent_avg": round(sum(recent) / len(recent), 1) if recent else None,
           "base_avg": round(sum(base) / len(base), 1) if base else None, "recent_minutes": len(recent)}
    if len(recent) >= config.RTT_TREND_MIN_RECENT and len(base) >= config.RTT_TREND_MIN_BASE:
        change = out["recent_avg"] - out["base_avg"]
        moved = abs(change) >= config.RTT_TREND_MS and abs(change) >= out["base_avg"] * config.RTT_TREND_PCT / 100
        out["trend"] = ("up" if change > 0 else "down") if moved else "steady"
    return out


def rtt_last5(points):
    """{last5_avg, last5_end, last5_minutes}: the 5 minutes ending at the newest sample, so a change
    (e.g. a path move) shows at the next refresh instead of hiding in the period's p95."""
    newest = points[-1][0]
    recent = [v for m, v in points if m >= newest - 4]
    return {"last5_avg": round(sum(recent) / len(recent), 1), "last5_end": minute_iso(newest), "last5_minutes": len(recent)}


def app_rtt(client, site_id, app_id, start, end):
    """(RTT figures over [start, end) or None without samples, error): one AppRoundTripTime query."""
    try:
        resp = query_metrics(client, [RTT_METRIC], {"site": [site_id], "app": [app_id]}, APP_VIEW, start, end)
    except ApiError as e:
        return None, str(e)
    # Zeros are minutes without a sample (seen live: an app at 0 ms all day), not 0 ms.
    points = sorted(p for s in iter_series(resp) for p in _minute_points(s) if p[1] > 0)
    if not points:
        return None, None  # some busy TCP apps report no RTT
    return {**_ms_stats(points), **rtt_trend(points, end), **rtt_last5(points)}, None


def prefix_events(client, site_id, app_id, start, end):
    """Per-destination-prefix events for one app (monitor/aggregates PrefixList, the request the
    Prisma SD-WAN UI makes; the app filter is mandatory, one app). Only prefixes with events come
    back, so no rows = none recorded: none happened, or prefix tracking is off at the site.
    -> {prefix_events: True | False | None, app_unreachable, prefixes, prefix_error?}"""
    empty = {"prefix_events": None, "app_unreachable": None, "prefixes": []}
    try:
        resp = client.request("POST", f"/sdwan/monitor/{V.AGGREGATES}/api/monitor/aggregates", json={
            "start_time": iso(start), "end_time": iso(end),
            "filter": {"site": [site_id], "app": [app_id]}, "aggregates": [{"name": "PrefixList"}]})
    except ApiError as e:
        return {**empty, "prefix_error": str(e)}
    rows = [i for agg in resp.get("aggregates") or [] for i in (agg.get("data") or {}).get("items") or []]
    if not rows:
        return {**empty, "prefix_events": False}
    n = lambda r, k: int(r.get(k) or 0)  # noqa: E731
    prefixes = sorted(({"prefix": r.get("prefix") or "", "failed_connections": n(r, "failed_connection_events"),
                        "app_unreachable": n(r, "app_unreachable_events"), "failed_txn_events": n(r, "failed_transaction_events")}
                       for r in rows),
                      key=lambda r: (-r["failed_connections"], -r["app_unreachable"], -r["failed_txn_events"], r["prefix"]))
    return {"prefix_events": True, "app_unreachable": sum(r["app_unreachable"] for r in prefixes), "prefixes": prefixes}


def txn_rates(failures, total, recent_failures, recent_total):
    """The period's failed-transaction % and the last TXN_RECENT's against the rest (the normal)."""
    base_failures, base_total = failures - recent_failures, total - recent_total
    pct = 100 * failures / total
    recent_pct = 100 * recent_failures / recent_total if recent_total else None
    base_pct = 100 * base_failures / base_total if base_total >= config.TXN_BASE_MIN else None
    if recent_pct is None or recent_total < config.TXN_MIN:
        flagged = False
    elif base_pct is None:
        flagged = recent_pct >= config.TXN_NO_BASE_PCT
    else:
        flagged = recent_pct >= config.TXN_RATIO * base_pct and recent_pct - base_pct >= config.TXN_POINTS
    r = lambda v: None if v is None else round(v, 1)  # noqa: E731
    return {"pct": r(pct), "recent_pct": r(recent_pct), "recent_failures": recent_failures,
            "recent_transactions": recent_total, "base_pct": r(base_pct), "flagged": flagged}


def app_perf(client, site_id, app_id, start, end):
    """SRT, RTT and UDP TRT (p95 / avg / peak of 1-minute values; None when not reported) and the
    failed-transaction rate for one app: one query. -> {srt, rtt, udp_trt, failures, transactions,
    txn?, perf_error?}"""
    out = {"srt": None, "rtt": None, "udp_trt": None, "failures": None, "transactions": None}
    try:
        resp = query_metrics(client, PERF_METRICS, {"site": [site_id], "app": [app_id]}, APP_VIEW, start, end)
    except ApiError as e:
        return {**out, "perf_error": str(e)}
    times = {"appserverresponsetime": "srt", "approundtriptime": "rtt", "appudptransactionresponsetime": "udp_trt"}
    counts = {"apptransactionfailures": "failures", "apptotaltransactions": "transactions"}
    split = minute_of(end - config.TXN_RECENT)
    recent = {}
    for s in iter_series(resp):
        name = str(s.get("name", "")).lower()
        points = _minute_points(s)
        if name in counts:
            key = counts[name]
            out[key] = int(round(sum(v for _, v in points))) if points else None
            recent[key] = int(round(sum(v for m, v in points if m >= split)))
        elif name in times:
            if name == "approundtriptime":
                points = [p for p in points if p[1] > 0]  # as in the list: 0 = no sample
            out[times[name]] = _ms_stats(points) or out[times[name]]
    if out["transactions"]:
        out["txn"] = txn_rates(out["failures"] or 0, out["transactions"], recent.get("failures", 0), recent.get("transactions", 0))
    return out

