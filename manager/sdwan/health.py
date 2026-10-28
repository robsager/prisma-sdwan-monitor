"""AIOps health (monitor/aiops/health): each site, app and link good / fair / poor, as in SCM.

Verified live with 1.x: one query per kind, filter {"<kind>_health": ["all"]}, view "summary"; each
data row has good / fair / poor / others buckets with a count and the ids in it (others: apps with
too little data). Some tenants return no rows for a kind.
"""
from ..config import V
from ..timeutil import iso, minute_iso, minute_of
from .metrics import iter_series, series_points
from .stats import median

KINDS = {"apps": ("application", "application_ids"), "sites": ("site", "site_ids"), "links": ("link", "path_ids")}
CATEGORIES = ("good", "fair", "poor", "others")


def query(client, kind, start, end):
    name = KINDS[kind][0]
    return client.request("POST", f"/sdwan/monitor/{V.AIOPS}/api/monitor/aiops/health", json={
        "start_time": iso(start), "end_time": iso(end), "interval": "5min", "view": "summary",
        "filter": {f"{name}_health": ["all"]}})


def parse(resp, kind):
    """({id: category}, {good, fair, poor, others, total})."""
    ids_key = KINDS[kind][1]
    cats, counts = {}, {c: 0 for c in CATEGORIES}
    counts["total"] = 0
    for row in resp.get("data") or []:
        counts["total"] += int(row.get("total") or 0)
        for cat in CATEGORIES:
            bucket = row.get(cat) or {}
            counts[cat] += int(bucket.get("count") or 0)
            for oid in bucket.get(ids_key) or []:
                cats[oid] = cat
    return cats, counts


# ---- 5-minute categories and link quality (Health issues' details) ---------------------------------
#
# Verified live 2026-10-27: view "timeseries" lists, per category, one bucket per 5-minute interval
# ({count, <kind>_ids, time: the interval's start}); the newest ~20 minutes aren't scored yet and are
# left out. AIOps gives no reason for a category: a link's quality (LQM) in its bad intervals is the
# Manager's own estimate (link_cause). AIOps' link ids are vpnlink ids for VPN links and the
# topology path_id for service and direct internet links; LQM takes either as filter.path, with
# filter.site the branch end: a data center end returns no points, whichever end the topology calls
# the source (live check 2026-10-27, 3 tenants).

SCORED = ("good", "fair", "poor")


def timeseries_query(client, kind, start, end):
    name = KINDS[kind][0]
    return client.request("POST", f"/sdwan/monitor/{V.AIOPS}/api/monitor/aiops/health", json={
        "start_time": iso(start), "end_time": iso(end), "interval": "5min", "view": "timeseries",
        "filter": {f"{name}_health": ["all"]}})


def parse_timeseries(resp, kind):
    """{id: {interval start (ISO, as in metrics): category}}."""
    ids_key = KINDS[kind][1]
    out = {}
    for row in resp.get("data") or []:
        for cat in SCORED:
            for bucket in row.get(cat) or []:
                t = bucket.get("time")
                t = t and minute_iso(minute_of(t))  # the same key as LQM's points
                for oid in bucket.get(ids_key) or [] if t else []:
                    out.setdefault(oid, {})[t] = cat
    return out


def timeline(cats, slots):
    """One character per 5-minute slot: g / f / p, "-" where AIOps has no score (yet)."""
    return "".join((cats.get(t) or "-")[0] for t in slots)


LINK_METRICS = [
    ("latency", [{"name": "LqmLatency", "statistics": ["average"], "unit": "milliseconds"}], {"individual": "path", "summary": False}),
    ("jitter/loss/MOS", [{"name": n, "statistics": ["average"], "unit": u} for n, u in
                         (("LqmJitter", "milliseconds"), ("LqmPacketLoss", "Percentage"), ("LqmMos", "count"))],
     {"individual": "direction", "summary": False}),
]
_KEY = {"lqmlatency": "latency", "lqmjitter": "jitter", "lqmpacketloss": "loss", "lqmmos": "mos"}


def quality_end(ends, hubs):
    """The end of a link to query its quality from: the first one at a branch (hubs: data center
    site ids), else the first with a site; None without any."""
    known = [e for e in ends if e.get("site_id")]
    return next((e for e in known if e["site_id"] not in hubs), known[0] if known else None)


def link_quality_body(metrics, view, site_id, path_id, start, end, interval="5min"):
    return {"start_time": iso(start), "end_time": iso(end), "interval": interval, "metrics": metrics,
            "filter": {"site": [site_id], "path": [path_id]}, "view": view}


def parse_link_quality(resp, into):
    """Adds {key: {time: value}} to into: latency, jitter_in / _out, loss_in / _out, mos_in / _out
    (Ingress = into the queried site)."""
    for s in iter_series(resp):
        key = _KEY.get(str(s.get("name", "")).lower())
        if not key:
            continue
        direction = str((s.get("view") or {}).get("direction", "")).lower()
        key += {"ingress": "_in", "egress": "_out"}.get(direction, "")
        into[key] = {minute_iso(minute_of(t)): v for t, v in series_points(s)}
    return into


def _fmt(v, digits):
    return f"{v:.{digits}f}"


def link_cause(cats, quality, site, limits):
    """The Manager's estimate of why a link was fair or poor: {bad, scored, explained, findings:
    [{metric, text, intervals}], note}. cats: {time: category} from AIOps; quality from
    parse_link_quality; limits: loss, latency_jump, jitter, mos (config's LINK_* values)."""
    bad = sorted(t for t, c in cats.items() if c in ("fair", "poor"))
    good = [t for t, c in cats.items() if c == "good"]
    out = {"bad": len(bad), "scored": len(cats), "explained": 0, "findings": [], "note": None}
    if not bad:
        out["note"] = "AIOps rated no 5-minute interval fair or poor in this window"
        return out
    if not any(quality.values()):
        out["note"] = "No link quality data for this link"
        return out
    where = {"in": f"into {site}" if site else "inbound", "out": f"out of {site}" if site else "outbound"}
    explained = set()

    def vals(series, times):
        return [(t, series[t]) for t in times if t in series]

    def add(metric, text, hits):
        out["findings"].append({"metric": metric, "text": f"{text} in {len(hits)} of {len(bad)} bad intervals", "intervals": len(hits)})
        explained.update(hits)

    for d in ("in", "out"):
        series = quality.get(f"loss_{d}") or {}
        hits = [t for t, v in vals(series, bad) if v >= limits["loss"]]
        good_max = max((v for _, v in vals(series, good)), default=0.0)
        top = max((v for _, v in vals(series, bad)), default=None)
        if hits and top > good_max:
            normal = f"good intervals ≤ {_fmt(good_max, 2)} %" if good_max >= 0.005 else "none in good intervals"
            add("loss", f"Loss {where[d]} up to {_fmt(top, 2)} % ({normal})", hits)
    series = quality.get("latency") or {}
    if series:
        usual = median(list(series.values()))
        hits = [t for t, v in vals(series, bad) if v - usual >= limits["latency_jump"]]
        if hits:
            top = max(series[t] for t in hits)
            add("latency", f"Latency up to {_fmt(top, 0)} ms, {_fmt(top - usual, 0)} ms over its usual {_fmt(usual, 0)} ms", hits)
    for d in ("in", "out"):
        series = quality.get(f"jitter_{d}") or {}
        if series:
            usual = median(list(series.values()))
            hits = [t for t, v in vals(series, bad) if v >= limits["jitter"] and v >= 2 * usual]
            if hits:
                add("jitter", f"Jitter {where[d]} up to {_fmt(max(series[t] for t in hits), 1)} ms (usual {_fmt(usual, 1)} ms)", hits)
    for d in ("in", "out"):
        series = quality.get(f"mos_{d}") or {}
        good_min = min((v for _, v in vals(series, good)), default=5.0)
        hits = [t for t, v in vals(series, bad) if v < limits["mos"] and v < good_min]
        if hits:
            add("mos", f"MOS {where[d]} down to {_fmt(min(series[t] for t in hits), 1)} (good intervals ≥ {_fmt(good_min, 1)})", hits)
    out["explained"] = len(explained)
    if not out["findings"]:
        out["note"] = "Nothing stands out in loss, latency, jitter or MOS in its bad intervals"
    return out


# ---- apps: AIOps' score and sites, and the Manager's reading of their response times -------------
#
# Verified live 2026-10-27: object_stats AppSummaryStats takes several apps (object_id a list) and
# gives each one's health score and its good / fair / poor sites; aggregates AppHealth takes one app
# and one site (filter.site / filter.app) and gives that site's score and counters over the window.
# Numbers can come as strings. Neither gives a reason. AIOps rates an app only in intervals with a
# response-time sample.

def app_stats_body(app_ids, start, end):
    return {"start_time": iso(start), "end_time": iso(end), "interval": "5min",
            "object_type": "AppSummaryStats", "object_id": list(app_ids)}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_app_stats(resp):
    """{app id: {score, sites: {fair: [site ids], poor: [...]}}}."""
    out = {}
    for row in resp.get("data") or []:
        sites = row.get("associated_sites") or {}
        out[row.get("object_id")] = {"score": _num(row.get("app_healthscore")),
                                     "sites": {c: list((sites.get(f"{c}_sites") or {}).get("items") or []) for c in ("fair", "poor")}}
    return out


def app_site_body(app_id, site_id, start, end):
    return {"start_time": iso(start), "end_time": iso(end), "interval": "5min", "aggregates": [{"name": "AppHealth"}],
            "filter": {"site": [site_id], "app": [app_id]}}


APP_COUNTERS = ("success_trans", "incomplete_trans", "fail_to_establish", "success_establish")


def parse_app_site(resp):
    """{score, success_trans, incomplete_trans, fail_to_establish, success_establish} or None."""
    for agg in resp.get("aggregates") or []:
        for item in (agg.get("data") or {}).get("items") or []:
            return {"score": _num(item.get("app_healthscore")), **{k: _num(item.get(k)) for k in APP_COUNTERS}}
    return None


def parse_app_perf(resp):
    """{rtt, srt, udp_trt, failures, transactions: {5-minute slot start: value}} (times averaged,
    counts summed per slot; an RTT of 0 is no sample)."""
    keys = {"approundtriptime": "rtt", "appserverresponsetime": "srt", "appudptransactionresponsetime": "udp_trt",
            "apptransactionfailures": "failures", "apptotaltransactions": "transactions"}
    out = {k: {} for k in keys.values()}
    for s in iter_series(resp):
        key = keys.get(str(s.get("name", "")).lower())
        if not key:
            continue
        sums = {}
        for t, v in series_points(s):
            if key == "rtt" and v <= 0:
                continue
            slot = minute_iso(minute_of(t) // 5 * 5)
            sums.setdefault(slot, []).append(v)
        out[key] = {t: (sum(vs) if key in ("failures", "transactions") else sum(vs) / len(vs)) for t, vs in sums.items()}
    return out


def app_cause(cats, perf, counters):
    """The Manager's reading of an app's response times and failures at one site in its fair and
    poor intervals: {bad, findings: [{metric, text}], verdict, note}."""
    bad = sorted(t for t, c in cats.items() if c in ("fair", "poor"))
    good = [t for t, c in cats.items() if c == "good"]
    out = {"bad": len(bad), "findings": [], "verdict": None, "note": None}
    if not bad:
        out["note"] = "AIOps rated no 5-minute interval fair or poor in this window"
        return out

    def span(key):
        vals = [perf.get(key, {}).get(t) for t in bad]
        vals = [v for v in vals if v is not None]
        usual = [perf[key][t] for t in good if t in perf.get(key, {})]
        return vals, (median(usual) if usual else None)

    rtt, rtt_usual = span("rtt")
    srt, srt_usual = span("srt")
    for key, label, vals, usual in (("rtt", "RTT", rtt, rtt_usual), ("srt", "Server response", srt, srt_usual)):
        if vals:
            text = f"{label} {_fmt(min(vals), 0)}–{_fmt(max(vals), 0)} ms in {len(vals)} of {len(bad)} bad intervals"
            out["findings"].append({"metric": key, "text": text + (f" (usual {_fmt(usual, 0)} ms)" if usual is not None else "")})
    fails = sum(perf.get("failures", {}).get(t) or 0 for t in bad)
    total = sum(perf.get("transactions", {}).get(t) or 0 for t in bad)
    if fails and total:
        out["findings"].append({"metric": "failures", "text": f"Transaction failures {_fmt(fails / total * 100, 1)} % in its bad intervals"})
    c = counters or {}
    no_failures = not fails and not (c.get("fail_to_establish") or 0) and not (c.get("incomplete_trans") or 0)
    if (c.get("fail_to_establish") or 0) > 0:
        out["verdict"] = "Connections failing to establish"
    elif fails and total and fails / total >= 0.05:
        out["verdict"] = "Transactions failing"
    elif rtt and srt and max(srt) >= max(rtt):
        out["verdict"] = "Looks like the server is slow to respond"
    elif rtt and no_failures and (not srt or max(srt) < min(rtt) / 2):
        out["verdict"] = "Looks like network delay to the app, not the server"
    if not out["findings"]:
        out["note"] = "No response-time samples in its bad intervals"
    return out
