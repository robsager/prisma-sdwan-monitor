"""Flow Search: monitor/flows queries, what is kept of each flow record, and the names flows carry
only as ids (policy rules, the probe behind a Move Flows rule).

Verified live with 1.x:
  * monitor/flows answers only for the hour ending at end_time, whatever start_time says, and has no
    total: a range is read as hourly windows, each paged with dest_page until a short page.
  * debug_level "all" is the only accepted value; without it RTT / SRT / UDP TRT and the security
    rules are missing.
  * filter.flow.destination_port takes a list of ints (any matches), filter.flow.protocol one int;
    source_ip and destination_ip combine as AND, so "either" direction is two queries.
  * A flow open across an hour boundary comes once per window, each record counting only that
    window's bytes, packets and retransmits (15 + 15 + 30 minute windows add up to the hour's), with
    its path and end reason as of the window's end ("unknown" while still open).
"""
import hashlib
import json
from datetime import datetime, timezone

from .. import config
from ..config import V

IP_MODES = ("source", "dest", "either")
PROTOCOLS = {6: "TCP", 17: "UDP", 1: "ICMP"}

# The fields the page reads (columns, filters, sorting, drop reasons, Flow Move); records carry ~111,
# and keeping these cut a branch's flows from ~3.3 KB to ~1.3 KB of JSON each, for the poll responses,
# the browser's memory and the hour cache. Keep in step with static/js/flows-model.js, and bump
# FIELDS_VERSION when what slim() keeps changes, so hours cached the old way are read again.
FIELDS = frozenset({
    "flow_start_time_ms", "source_ip", "source_port", "destination_ip", "destination_port", "protocol",
    "user_name", "app_id", "unknown_domain", "flow_direction", "path_id", "path_type",
    "network_policy_id", "priority_policy_id", "security_policy_rules", "sec_policy_actions",
    "average_rtt", "average_srt", "average_udp_trt", "bytes_c2s", "bytes_s2c", "packets_c2s", "packets_s2c",
    "flow_action", "session_end_reason", "init_success", "syn_c2s", "syn_s2c", "fin_c2s", "reset_c2s", "reset_s2c",
    "flow_decision_metadata_list",
    # Optional columns: duration, retransmits, WAN path change, voice/video quality.
    "flow_end_time_ms", "retransmit_pkts_c2s", "retransmit_pkts_s2c", "retransmit_bytes_c2s", "retransmit_bytes_s2c",
    "wan_path_change_reason", "avg_jitter_c2s", "avg_jitter_s2c", "avg_packet_loss_c2s", "avg_packet_loss_s2c",
    "avg_mos_c2s", "avg_mos_s2c",
    # SCM's "Assurance: Flow Move": a performance policy Move Flows action put the flow on its path
    # (independent of wan_path_change_reason, null on every moved flow checked).
    "is_move_flow",
})
# Usually null (a path change on ~0.2% of flows; jitter, loss and MOS empty on every flow checked, even
# Teams media, which is encrypted): dropped when null. is_move_flow (false on ~90%) is kept only when true.
SPARSE = frozenset({"wan_path_change_reason", "avg_jitter_c2s", "avg_jitter_s2c", "avg_packet_loss_c2s",
                    "avg_packet_loss_s2c", "avg_mos_c2s", "avg_mos_s2c"})
TRUE_ONLY = frozenset({"is_move_flow"})
SECURITY_RULE_FIELDS = ("security_policy_rule_id", "security_policy_rule_action")
DECISION_FIELDS = ("policy_allowed_wan_paths", "state_up_policy_allowed_wan_paths", "flow_decision_bitmap")
# Moved flows also keep why: the paths left after the SLA check, the per-reason bitmaps of bad paths
# (app_perf_rtt_bad_paths_bitmap 5 = bits 0 and 2 of state_up_policy_allowed_wan_paths) and the path
# chosen, for every decision, oldest first (a flow moved mid-way has one per choice). Dropped flows
# keep their last decision's DECISION_FIELDS (the drop reason); other flows none (nothing reads them).
MOVE_DECISION_FIELDS = ("sla_filtered_state_up_policy_allowed_wan_paths", "chosen_wan_path", "flow_decision_time")
BAD_PATHS_SUFFIX = "_bad_paths_bitmap"
FIELDS_VERSION = 6  # part of every hour-cache key (1.x's version 6 keeps the same fields)


# ---- time windows -----------------------------------------------------------------------------------

def parse_iso(value):
    """ISO-8601 timestamp (e.g. JS toISOString()) -> aware UTC datetime. Raises ValueError."""
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fmt_iso(dt):
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond // 1000:03d}Z"


def windows(start, end):
    """[start, end] split at whole UTC hours, newest first: partial windows at either end, whole hours
    between (so overlapping searches ask for the same, cacheable, hours)."""
    out = []
    window_end = end
    while window_end > start:
        hour = window_end.replace(minute=0, second=0, microsecond=0)
        window_start = max(start, hour if hour < window_end else hour - config.FLOW_WINDOW)
        out.append((window_start, window_end))
        window_end = window_start
    return out



def ip_fields(ip_address, ip_mode):
    """The flow filter field of each query run per window: [None] without an IP filter."""
    if not ip_address:
        return [None]
    if ip_mode == "either":
        return ["source_ip", "destination_ip"]
    return ["destination_ip"] if ip_mode == "dest" else ["source_ip"]


# ---- the search -------------------------------------------------------------------------------------

class SearchError(ValueError):
    """A search request the page should have refused (the message says why)."""


def parse_search(body, now=None):
    """The POST /flows/search body -> a validated spec dict. Raises SearchError."""
    site_ids = [str(s) for s in body.get("site_ids") or []]
    app_ids = [str(a) for a in body.get("app_ids") or []]
    ip_address = str(body.get("ip_address") or "").strip()
    ip_mode = body.get("ip_mode") or "source"
    try:
        dest_ports = sorted({int(p) for p in body.get("dest_ports") or []})
        protocol = int(body.get("protocol") or 0)
    except (TypeError, ValueError):
        raise SearchError("Ports and protocol must be whole numbers.") from None
    if any(not 1 <= p <= 65535 for p in dest_ports):
        raise SearchError("Ports must be between 1 and 65535.")
    if len(dest_ports) > config.FLOW_MAX_DEST_PORTS:
        raise SearchError(f"At most {config.FLOW_MAX_DEST_PORTS} destination ports.")
    if protocol and protocol not in PROTOCOLS:
        raise SearchError("Protocol must be TCP, UDP or ICMP.")
    if ip_mode not in IP_MODES:
        raise SearchError(f"ip_mode must be one of: {', '.join(IP_MODES)}.")
    if not site_ids:
        raise SearchError("No sites selected.")
    try:
        start, end = parse_iso(body.get("start_time") or ""), parse_iso(body.get("end_time") or "")
    except ValueError:
        raise SearchError("Start and end time must be ISO-8601 timestamps.") from None
    if start >= end:
        raise SearchError("Start time must be before end time.")
    if end - start > config.FLOW_MAX_UNFILTERED and not (app_ids or ip_address):
        raise SearchError("Searches over 4 hours need an application or IP address filter: unfiltered, "
                          "a busy site has hundreds of thousands of flows a day.")
    if start < (now or datetime.now(timezone.utc)) - config.FLOW_MAX_AGE:
        raise SearchError(f"Flow Search covers the last {config.FLOW_MAX_AGE.days} days only: pick a start inside them.")
    return {"site_ids": list(dict.fromkeys(site_ids)), "app_ids": app_ids, "ip_address": ip_address, "ip_mode": ip_mode,
            "dest_ports": dest_ports, "protocol": protocol, "start": start, "end": end}


def payload(spec, site_id, ip_field, window_start, window_end, dest_page, page_size=None):
    flt = {"site": [site_id]}
    if spec["app_ids"]:
        flt["app"] = spec["app_ids"]
    flow = {}
    if ip_field and spec["ip_address"]:
        flow[ip_field] = [spec["ip_address"]]
    if spec["dest_ports"]:
        flow["destination_port"] = spec["dest_ports"]
    if spec["protocol"]:
        flow["protocol"] = spec["protocol"]
    if flow:
        flt["flow"] = flow
    return {"start_time": fmt_iso(window_start), "end_time": fmt_iso(window_end), "debug_level": "all",
            "page_size": page_size or config.FLOW_PAGE_SIZE, "dest_page": dest_page, "view": {"summary": False},
            "filter": flt}


PATH = f"/sdwan/monitor/{V.FLOWS}/api/monitor/flows"


def window_key(tsg_id, spec, site_id, ip_field, window, now=None):
    """The hour cache key of a whole past hour, or None for one that can't be cached (partial, or
    ended under FLOW_CACHE_MIN_AGE ago: flows are reported as they end)."""
    now = now or datetime.now(timezone.utc)
    window_start, window_end = window
    if window_end > now - config.FLOW_CACHE_MIN_AGE or window_end - window_start != config.FLOW_WINDOW:
        return None
    ident = [tsg_id, site_id, fmt_iso(window_start), fmt_iso(window_end), V.FLOWS,
             sorted(spec["app_ids"]), spec["ip_address"] if ip_field else "", ip_field or "", spec["dest_ports"],
             spec["protocol"], FIELDS_VERSION]
    return hashlib.sha256(json.dumps(ident).encode()).hexdigest()


# ---- flow records -----------------------------------------------------------------------------------

def key(flow):
    """A flow's identity, the same in every window and both IP directions (flows-model.js flowKey)."""
    return (flow.get("source_ip"), flow.get("source_port"), flow.get("destination_ip"),
            flow.get("destination_port"), flow.get("protocol"), flow.get("flow_start_time_ms"))


def slim(flow):
    """Only FIELDS, and inside the security rules and path decisions only what the page reads: every
    decision (oldest first) for moved flows, the last one for dropped flows, none for others. Absent
    fields stay absent: the page tells "not reported" from empty (e.g. session_end_reason)."""
    out = {k: v for k, v in flow.items()
           if k in FIELDS and not (v is None and k in SPARSE) and not (k in TRUE_ONLY and v is not True)}
    if out.get("security_policy_rules"):
        out["security_policy_rules"] = [{k: r.get(k) for k in SECURITY_RULE_FIELDS} for r in out["security_policy_rules"]]
    moved, dropped = out.get("is_move_flow"), out.get("flow_action") == "flow_drop"
    if not (moved or dropped):
        out.pop("flow_decision_metadata_list", None)
    elif out.get("flow_decision_metadata_list"):
        decisions = sorted(out["flow_decision_metadata_list"], key=lambda md: md.get("flow_decision_time") or 0)
        if moved:
            out["flow_decision_metadata_list"] = [
                {**{k: md.get(k) for k in DECISION_FIELDS},
                 **{k: v for k, v in md.items() if k in MOVE_DECISION_FIELDS or (k.endswith(BAD_PATHS_SUFFIX) and v)}}
                for md in decisions]
        else:
            out["flow_decision_metadata_list"] = [{k: decisions[-1].get(k) for k in DECISION_FIELDS}]
    return out


# ---- names ------------------------------------------------------------------------------------------

POLICY_KINDS = {  # kind -> (sets path, rules path of a set, rules query path)
    "network": (f"/sdwan/{V.NETPOLICYSETS}/api/networkpolicysets",
                f"/sdwan/{V.NETPOLICYRULES}/api/networkpolicysets/{{}}/networkpolicyrules",
                f"/sdwan/{V.NETPOLICYRULES}/api/networkpolicyrules/query"),
    "priority": (f"/sdwan/{V.PRIOPOLICYSETS}/api/prioritypolicysets",
                 f"/sdwan/{V.PRIOPOLICYRULES}/api/prioritypolicysets/{{}}/prioritypolicyrules",
                 f"/sdwan/{V.PRIOPOLICYRULES}/api/prioritypolicyrules/query"),
    "security": (f"/sdwan/{V.SECPOLICYSETS}/api/ngfwsecuritypolicysets",
                 f"/sdwan/{V.SECPOLICYRULES}/api/ngfwsecuritypolicysets/{{}}/ngfwsecuritypolicyrules",
                 f"/sdwan/{V.SECPOLICYRULES}/api/ngfwsecuritypolicyrules/query"),
}
RULES_QUERY_PAGE = 100
MAX_RULES_QUERY_PAGES = 50


def rule_names(rules):
    return {r["id"]: r.get("name") or r["id"] for r in rules if r.get("id")}


def rules_by_query(client, query_path):
    """Every rule of one policy type from its rules/query endpoint, paged like waninterfaces/query
    (limit + dest_page): one call for most tenants where 1.x made one per policy set. None when the
    pages stop short of total_count."""
    items = []
    for page in range(1, MAX_RULES_QUERY_PAGES + 1):
        body = {"limit": RULES_QUERY_PAGE, **({"dest_page": page} if page > 1 else {})}
        resp = client.request("POST", query_path, json=body)
        batch = resp.get("items") or []
        items += batch
        total = resp.get("total_count")
        if len(batch) < RULES_QUERY_PAGE or (isinstance(total, int) and len(items) >= total):
            break
    total = resp.get("total_count")
    return None if isinstance(total, int) and len(items) < total else items


def probe_slas(rules, thresholds, probe_configs):
    """app id -> [{rule, probe, protocol, metric, limit}]: enabled Move Flows rules whose threshold
    profile sets a probe latency limit, for naming what a probe move measured. The flow record only says
    a probe dropped the paths (the same decision bit for every probe type), while SCM names the metric
    from the probe: "High UDP TRT" for a DNS probe, "High RTT" for HTTP (seen live with 1.x). As
    configured now, so flows from before a change get today's probe."""
    out = {}
    for rule in rules:
        moves = any(str(a.get("action_type", "")).startswith("move_flows") for a in rule.get("actions") or [])
        if rule.get("enabled") is False or not moves:
            continue
        latency = ((thresholds.get(rule.get("thresholdprofile_id")) or {}).get("synthetic_probe_thresholds") or {}).get("latency") or {}
        cfg = probe_configs.get(latency.get("probe_config_id"))
        if not cfg:
            continue
        protocol = str(((cfg.get("endpoints") or [{}])[0]).get("protocol") or "").upper()
        for app_id in (rule.get("app_filters") or {}).get("application_ids") or []:
            out.setdefault(app_id, []).append({"rule": rule.get("name"), "probe": cfg.get("name"), "protocol": protocol,
                                               "metric": "UDP TRT" if protocol == "DNS" else "RTT", "limit": latency.get("value")})
    return out
