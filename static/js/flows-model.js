// Flow Search: what a flow record means (columns, sorting, filters, drop reasons, Flow Move, return
// traffic, retransmits), summaries, CSV and the time range. No DOM or Alpine here, so it's tested on
// its own (tests/js/flows-model.test.js).
//
// Most helpers take `names`: { apps: {id: name}, paths: {id: name | {name, by_site}},
// network / priority / security: {rule id: name}, probeSlas: {app id: [{rule, probe, protocol, metric, limit}]} }.
// Flow fields read here must be in manager/sdwan/flows.py FIELDS: the server drops the rest.

export const PROTOCOLS = { 1: "ICMP", 6: "TCP", 17: "UDP", 47: "GRE", 50: "ESP", 51: "AH", 58: "ICMPv6", 89: "OSPF", 132: "SCTP" };

const numberFormat = new Intl.NumberFormat();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const compareText = (a, b) => collator.compare(a, b);

// ---- one flow, possibly from several hourly records -----------------------------------------------

// Same identity as flows.py key().
export const flowKey = (f) => `${f.source_ip}|${f.source_port}|${f.destination_ip}|${f.destination_port}|${f.protocol}|${f.flow_start_time_ms}`;

// A flow open across an hour boundary comes as one record per window: the first as a flow, the rest
// as updates. Each counts only its window's bytes, packets and retransmits, so those add up; the rest
// (path, end reason, averages) comes from the newest record, i.e. as of the end of the searched range.
// _paths keeps every record's [last update, path_id, path_type], oldest first: the path before a change.
const SUMMED = ["bytes_c2s", "bytes_s2c", "packets_c2s", "packets_s2c",
  "retransmit_pkts_c2s", "retransmit_pkts_s2c", "retransmit_bytes_c2s", "retransmit_bytes_s2c"];
const recordPaths = (f) => f._paths || [[f.flow_end_time_ms || 0, f.path_id, f.path_type]];

export function mergeFlowRecords(a, b) {
  const [older, newer] = (a.flow_end_time_ms || 0) <= (b.flow_end_time_ms || 0) ? [a, b] : [b, a];
  // Sparse fields (e.g. the path change reason) are absent when null, so an older value survives.
  const merged = { ...older, ...newer };
  for (const k of SUMMED) {
    if (a[k] != null || b[k] != null) merged[k] = (Number(a[k]) || 0) + (Number(b[k]) || 0);
  }
  merged._paths = [...recordPaths(a), ...recordPaths(b)].sort((x, y) => x[0] - y[0]);
  // Moved flows: every path decision of both records, once each, oldest first.
  if (a.is_move_flow || b.is_move_flow) {
    const byTime = new Map();
    for (const md of [...(older.flow_decision_metadata_list || []), ...(newer.flow_decision_metadata_list || [])]) {
      byTime.set(md.flow_decision_time ?? JSON.stringify(md), md);
    }
    const ds = [...byTime.values()].sort((x, y) => (x.flow_decision_time || 0) - (y.flow_decision_time || 0));
    if (ds.length) merged.flow_decision_metadata_list = ds;
  }
  return merged;
}

// ---- names ----------------------------------------------------------------------------------------

export const appName = (names, id) => (id ? names.apps?.[id] || String(id) : "-");
export const protocolName = (p) => PROTOCOLS[p] || (p != null && p !== "" ? String(p) : "-");
export const protocolClass = (p) => ({ 6: "pill-blue", 17: "pill-green", 1: "pill-yellow", 58: "pill-yellow" })[p] || "pill-gray";

// Fabric links are named from the flow's site's side: "local circuit → remote site (circuit)".
export function pathLabel(names, id, siteName) {
  const p = id && names.paths?.[id];
  if (!p) return null;
  return typeof p === "string" ? p : (p.by_site?.[siteName] || p.name);
}
export const pathName = (names, flow, id = flow.path_id, type = flow.path_type) =>
  pathLabel(names, id, flow._site_name) || type || "-";

const ruleName = (map, id) => (id ? map?.[id] || id : "-");
export const networkPolicy = (names, f) => ruleName(names.network, f.network_policy_id);
export const priorityPolicy = (names, f) => ruleName(names.priority, f.priority_policy_id);
export const securityPolicy = (names, f) => ruleName(names.security, (f.security_policy_rules || [])[0]?.security_policy_rule_id);

export function securityActions(f) {
  if (f.security_policy_rules?.length) return [...new Set(f.security_policy_rules.map((r) => r.security_policy_rule_action).filter(Boolean))];
  return f.sec_policy_actions?.length ? f.sec_policy_actions : [];
}

// ---- figures --------------------------------------------------------------------------------------

export const totalBytes = (f) => (Number(f.bytes_c2s) || 0) + (Number(f.bytes_s2c) || 0);
export const totalPackets = (f) => (Number(f.packets_c2s) || 0) + (Number(f.packets_s2c) || 0);
export const flowDuration = (f) => (f.flow_end_time_ms && f.flow_start_time_ms ? f.flow_end_time_ms - f.flow_start_time_ms : null);
// Still open at the end of the searched range: the ION reports session_end_reason "unknown" until the
// flow ends (verified live with 1.x: every such flow had a record in the next hour, no other did).
export const flowOpen = (f) => f.session_end_reason === "unknown";
// An RTT of 0 means no measurement, not 0 ms (verified live: ~1% of TCP flows).
export const flowRtt = (f) => (f.average_rtt === 0 ? null : f.average_rtt);

// Retransmit fields are on TCP flows only (absent: null, shown as "-").
export function retxSum(f, prefix) {
  const c2s = f[`${prefix}_c2s`], s2c = f[`${prefix}_s2c`];
  return c2s == null && s2c == null ? null : (Number(c2s) || 0) + (Number(s2c) || 0);
}
// Keepalive probes: 1 byte at an acknowledged sequence number, counted as a retransmit even when
// answered (browsers send one every ~45 s on idle connections). A direction with Retx Bytes = Retx Pkts
// sent only probes; those are left out of Retx % and sorting. A direction mixing both counts as real.
export function retxProbes(f) {
  return ["c2s", "s2c"].reduce((sum, d) => {
    const p = Number(f[`retransmit_pkts_${d}`]) || 0;
    return sum + (p > 0 && Number(f[`retransmit_bytes_${d}`]) === p ? p : 0);
  }, 0);
}
export function retxReal(f) {
  const n = retxSum(f, "retransmit_pkts");
  return n == null ? null : n - retxProbes(f);
}
export function retxPct(f) {
  const n = retxReal(f), total = totalPackets(f);
  return n == null || !total ? null : (n / total) * 100;
}
// Jitter / loss / MOS: the worse direction (max, or min for MOS); null when neither is reported.
export function worseDirection(f, prefix, pick) {
  const v = [f[`${prefix}_c2s`], f[`${prefix}_s2c`]].filter((x) => x != null).map(Number);
  return v.length ? pick(...v) : null;
}
export function directionTip(f, prefix) {
  const c2s = f[`${prefix}_c2s`], s2c = f[`${prefix}_s2c`];
  return c2s == null && s2c == null ? "" : `C2S ${c2s ?? "-"} · S2C ${s2c ?? "-"}`;
}

// ---- formatting -----------------------------------------------------------------------------------

export const formatCount = (n) => numberFormat.format(n || 0);
export const formatMs = (v) => (v == null ? "-" : `${Math.round(v)}ms`);
export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${sizes[i]}`;
}
export function formatDuration(ms) {
  if (ms == null) return "-";
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
const pad = (n) => String(n).padStart(2, "0");
export function formatTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const formatDirection = (dir) => (dir ? dir.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()) : "-");

export function retxPktsText(f) {
  const n = retxSum(f, "retransmit_pkts"), probes = retxProbes(f);
  if (n == null) return "-";
  if (!probes) return formatCount(n);
  return probes === n ? `${formatCount(n)} keepalive` : `${formatCount(n)} (${formatCount(probes)} keepalive)`;
}
export function retxTip(f) {
  const tip = directionTip(f, "retransmit_pkts"), probes = retxProbes(f);
  return probes ? `${tip}\n${formatCount(probes)} are 1-byte keepalive probes, not lost data: left out of Retx % and sorting` : tip;
}

// ---- outcome ---------------------------------------------------------------------------------------

// session_end_reason is absent when not reported: IONs before 6.8 don't send it (6.8.1 on every flow,
// 6.5.3 on none).
export const endReasonText = (f) => (!("session_end_reason" in f) ? "n/a" : f.session_end_reason || "-");
export const END_REASON_NA_TIP = "Not reported: this ION’s software does not send the session end reason (seen on 6.5.x; 6.8.x reports it).";

// init_success is null where it doesn't apply (UDP, ICMP).
export const initSuccessText = (f) => (f.init_success == null ? "-" : f.init_success ? "Yes" : "No");

// What came back from the server. Dropped: the ION dropped the flow itself (Action says why), kept apart
// so "No" means forwarded but unanswered. Reset / SYN-ACK only: the only server packets were resets, or
// the SYN-ACK of a handshake that never completed.
export function returnTraffic(f) {
  if (f.flow_action === "flow_drop") return "Dropped";
  const s2c = f.packets_s2c || 0;
  if (!s2c) return (f.packets_c2s || 0) > 0 ? "No" : "-";
  if ((f.reset_s2c || 0) > 0 && s2c <= f.reset_s2c) return "Reset";
  if (f.init_success === false && (f.syn_s2c || 0) > 0 && s2c <= f.syn_s2c) return "SYN-ACK only";
  return "Yes";
}
export const returnTrafficClass = (text) =>
  ({ Yes: "pill-green", No: "pill-red", Reset: "pill-yellow", "SYN-ACK only": "pill-yellow", Dropped: "pill-gray" })[text] || "";

// Why a flow_drop flow was dropped, from fields on the record (there is no reason field):
// - TCP with no SYN from the client: the stateful firewall saw a mid-session packet for a session it
//   has no state for (seen live: single-packet FIN/ACK drops seconds after the session closed).
// - a denying security rule, e.g. deny_unknown_source_zone (an interface with no zone).
// - the last path decision: path policy allows paths but none are up. Trusted only after the checks
//   above: a flow dropped before path selection also has an empty "up" list.
// { text, detail } or null.
export function dropReason(names, f) {
  if (f.flow_action !== "flow_drop") return null;
  if (f.protocol === 6 && !f.syn_c2s && (f.packets_c2s || 0) > 0) {
    const kind = f.fin_c2s ? "a FIN" : f.reset_c2s ? "a reset" : "an ACK/data packet";
    return { text: "Firewall: TCP state violation", detail: `The first packet seen was ${kind}, not a SYN, so the ION had no session for it (already closed or timed out, or the SYN took another path) and the stateful firewall dropped it. Usually harmless late packets of a finished connection.` };
  }
  const sec = securityActions(f);
  if (sec.includes("deny_unknown_source_zone")) {
    return { text: "Security: no zone on source interface", detail: "Security policy denied the flow because its source interface has no security zone (deny_unknown_source_zone)." };
  }
  const deny = sec.find((a) => a !== "allow");
  if (deny) {
    const rule = securityPolicy(names, f);
    return { text: `Security policy: ${deny}`, detail: `Security rule ${rule !== "-" ? rule : "(unknown)"} action: ${deny}.` };
  }
  const ds = f.flow_decision_metadata_list || [];
  const md = ds[ds.length - 1];
  if (!md) return { text: "Reason not reported", detail: "The flow record has no security denial or path decision details." };
  const list = (ids) => ids.map((id) => pathLabel(names, id, f._site_name) || id).join(", ");
  const allowed = md.policy_allowed_wan_paths || [], up = md.state_up_policy_allowed_wan_paths || [];
  if (allowed.length && !up.length) {
    return { text: "No allowed path up", detail: `Path policy allows ${allowed.length} path${allowed.length === 1 ? "" : "s"}, none of them up: ${list(allowed)}.` };
  }
  if (!allowed.length && f.flow_direction === "lan_to_wan") {
    return { text: "No path allowed by path policy", detail: "The path policy rule matched allows no path that this site has." };
  }
  return { text: "Reason not reported", detail: `The path decision on the record does not show why (decision bitmap ${JSON.stringify(md.flow_decision_bitmap || [])}).` };
}

// ---- paths and Flow Move ---------------------------------------------------------------------------

// The paths the flow was on in the searched range, oldest first: one entry per run of hourly records on
// the same path, with the last update seen on it.
export function pathRuns(names, f) {
  return (f._paths || []).reduce((runs, [until, id, type]) => {
    const last = runs[runs.length - 1];
    if (last && last.id === id) last.until = until;
    else runs.push({ id, until, name: pathName(names, f, id, type) });
    return runs;
  }, []);
}
export function previousPath(names, f) {
  const runs = pathRuns(names, f);
  return runs.length > 1 ? runs[runs.length - 2] : null;
}
export function pathTip(names, f) {
  const runs = pathRuns(names, f), current = pathName(names, f);
  if (runs.length > 1) {
    return "Paths in the searched range, oldest first:\n" +
      runs.map((r, i) => `${r.name} (${i === runs.length - 1 ? "current" : `until ${formatTime(r.until)}`})`).join("\n");
  }
  if (f.wan_path_change_reason) {
    return `${current}\nMoved to this path (${f.wan_path_change_reason}). The path before isn't in the results: ` +
      "the change was before the searched range, or in the same hour as the earliest record. Search from before the flow started (Time) to see it.";
  }
  return current === "-" ? "" : current;
}

// Why a moved flow's paths were avoided: <reason>_bad_paths_bitmap keys seen live; others show the key's words.
const MOVE_REASONS = { app_perf_rtt_bad_paths_bitmap: "app RTT", app_unreach_bad_paths_bitmap: "app unreachable" };
// Which SLA filter dropped paths, from flow_decision_bitmap (4 x 32-bit words; bit n = word n>>5, bit
// n%32). Found live with 1.x: bit 60 on every app RTT move and no probe move, bit 84 on every probe move
// and no RTT move, neither on flows not moved. Bit 84 is the same for every probe type: the metric
// comes from the app's Move Flows rule (probeLabel).
const DECISION_FILTER_BITS = { 60: "high app RTT", 84: "probe" };
const decisionBit = (md, n) => Math.floor(Number((md.flow_decision_bitmap || [])[n >> 5] || 0) / 2 ** (n % 32)) % 2 === 1;

// "probe: high RTT" / "probe: high UDP TRT", as SCM names it, from the app's Move Flows rule (as
// configured now); just "probe" when no rule, or rules with different metrics, match.
export function probeLabel(names, f) {
  const metrics = [...new Set((names.probeSlas?.[f.app_id] || []).map((r) => r.metric))];
  return metrics.length === 1 ? `probe: high ${metrics[0]}` : "probe";
}

// is_move_flow (SCM: "Assurance: Flow Move"). Why, from the last path decision on the record:
// - Avoided paths: up paths missing from the SLA-filtered list; <reason>_bad_paths_bitmap bits (indexing
//   the up paths) give the reason. The bits alone don't mean avoided (with every path over the SLA the
//   ION still keeps some).
// - A move mid-flow: a later decision chose another path; "from" is the path chosen before.
// - Otherwise the flow was placed at the start; "from" is the first avoided path, the one it would have taken.
// { from: {id, name, reasons, flags, at?}, midFlow, avoided: [{id, name, reasons, flags}] } or null.
export function moveInfo(names, f) {
  if (!f.is_move_flow) return null;
  const ds = f.flow_decision_metadata_list || [];
  const md = ds[ds.length - 1] || {};
  const name = (id) => pathLabel(names, id, f._site_name) || id;
  const up = md.state_up_policy_allowed_wan_paths || [];
  const passed = md.sla_filtered_state_up_policy_allowed_wan_paths;
  const bad = new Map();
  for (const [k, bits] of Object.entries(md)) {
    if (!k.endsWith("_bad_paths_bitmap") || !bits) continue;
    const label = MOVE_REASONS[k] || k.replace(/_bad_paths_bitmap$/, "").replace(/_/g, " ");
    up.forEach((id, i) => { if (bits & (2 ** i)) bad.set(id, [...(bad.get(id) || []), label]); });
  }
  const out = passed && passed.length ? up.filter((id) => !passed.includes(id)) : [...bad.keys()];
  // The cause: the SLA filter bits when set. The bad-path bits are recorded whatever the rule measures,
  // so they're context then; without a filter bit they name the cause only when they flag exactly the
  // paths the SLA check dropped.
  const filters = Object.entries(DECISION_FILTER_BITS).filter(([n]) => decisionBit(md, Number(n)))
    .map(([, label]) => (label === "probe" ? probeLabel(names, f) : label));
  const bitsExplain = !filters.length && out.length === bad.size && out.every((id) => bad.has(id));
  const reasonsFor = (id) => (filters.length ? filters : bitsExplain ? bad.get(id) : ["other SLA check"]);
  const avoided = out.filter((id) => id !== md.chosen_wan_path)
    .map((id) => ({ id, name: name(id), reasons: reasonsFor(id), flags: filters.length || bitsExplain ? [] : bad.get(id) || [] }));
  const prev = ds.length > 1 ? ds[ds.length - 2].chosen_wan_path : null;
  let from = avoided[0] || null, midFlow = false;
  if (prev && md.chosen_wan_path && prev !== md.chosen_wan_path) {
    from = { id: prev, name: name(prev), reasons: [f.wan_path_change_reason || "reason not given"], flags: [], at: md.flow_decision_time };
    midFlow = true;
  }
  return { from, midFlow, avoided };
}

export function assuranceTip(names, f) {
  if (!f.is_move_flow) return "";
  const info = moveInfo(names, f);
  const slas = names.probeSlas?.[f.app_id] || [];
  const sla = info.avoided.some((a) => a.reasons.some((r) => r.startsWith("probe"))) && slas.length
    ? "\nProbe SLA (as configured now, so a flow from before a change shows today’s probe):\n" +
      slas.map((r) => `${r.rule}: ${r.probe} (${r.protocol}), ${r.metric} over ${r.limit} ms`).join("\n") : "";
  const base = "A performance policy rule with Move Flows chose the path for this flow." + sla;
  const list = info.avoided.length ? "\nKept off (failed the rule’s SLA at the last path decision):\n" +
    info.avoided.map((a) => `${a.name}: ${a.reasons.join(", ")}${a.flags.length ? ` (also flagged: ${a.flags.join(", ")})` : ""}`).join("\n") : "";
  const on = `\nOn: ${pathName(names, f)}`;
  if (info.midFlow) {
    const flags = info.from.flags.length ? `\nAlso flagged on that path: ${info.from.flags.join(", ")} (recorded whatever the rule measures, so not necessarily the trigger).` : "";
    return `${base}\nMoved mid-flow at ${formatTime(info.from.at)} from ${info.from.name} (${info.from.reasons.join(", ")}).${flags}${on}${list}`;
  }
  if (!info.from) return `${base}${on}\nThe record doesn’t say which path it was kept off.`;
  return `${base} It was placed there when it started; "from" is the path it would have taken.${on}${list}`;
}
export const moveFromText = (info) => (info?.from ? `from ${info.from.name} · ${info.from.reasons.join(", ")}` : "");

// ---- columns ---------------------------------------------------------------------------------------

// sort: the sortValue field (null: not sortable); numeric: largest first on the first click.
export const COLUMNS = [
  { key: "site", label: "Site", sort: "_site_name" },
  { key: "time", label: "Time", sort: "flow_start_time_ms", numeric: true },
  { key: "source_ip", label: "Source IP", sort: "source_ip", mono: true },
  { key: "user", label: "User", sort: "user_name", title: "User ID (if identified)" },
  { key: "source_port", label: "Src Port", sort: "source_port" },
  { key: "destination_ip", label: "Dest IP", sort: "destination_ip", mono: true },
  { key: "destination_port", label: "Dst Port", sort: "destination_port" },
  { key: "protocol", label: "Proto", sort: "protocol", pill: true },
  { key: "app", label: "App", sort: "app_name" },
  { key: "domain", label: "Domain", sort: "unknown_domain", title: "Detected domain (if any)" },
  { key: "path_policy", label: "Path Policy", sort: "path_policy", title: "Network (path) policy rule", policy: true },
  { key: "qos_policy", label: "QoS Policy", sort: "qos_policy", title: "Priority (QoS) policy rule", policy: true },
  { key: "security_policy", label: "Security Policy", sort: "security_policy", title: "Security (NGFW) policy rule", policy: true },
  { key: "direction", label: "Direction", sort: "flow_direction" },
  { key: "path", label: "Path", sort: "path" },
  { key: "path_change", label: "Path Change", sort: "wan_path_change_reason", title: "Why the flow moved to another WAN path, e.g. asymmetry_path_change (blank: it didn't move)" },
  { key: "assurance", label: "Assurance", sort: "is_move_flow", title: "Flow Move: a performance policy (Move Flows) put the flow on this path, e.g. after an SLA breach on another. Same as the Assurance column in SCM" },
  { key: "rtt", label: "Avg RTT", sort: "average_rtt", numeric: true, title: "Average round-trip time" },
  { key: "srt", label: "Avg SRT", sort: "average_srt", numeric: true, title: "Average server response time" },
  { key: "udp_trt", label: "Avg UDP TRT", sort: "average_udp_trt", numeric: true, title: "Average UDP transaction response time" },
  { key: "bytes_c2s", label: "Bytes C2S", sort: "bytes_c2s", numeric: true, title: "Bytes client to server" },
  { key: "bytes_s2c", label: "Bytes S2C", sort: "bytes_s2c", numeric: true, title: "Bytes server to client" },
  { key: "bytes_total", label: "Total Bytes", sort: "bytes_total", numeric: true, title: "Bytes in both directions" },
  { key: "packets_c2s", label: "Packets C2S", sort: "packets_c2s", numeric: true, title: "Packets client to server" },
  { key: "packets_s2c", label: "Packets S2C", sort: "packets_s2c", numeric: true, title: "Packets server to client" },
  { key: "packets_total", label: "Total Packets", sort: "packets_total", numeric: true, title: "Packets in both directions" },
  { key: "duration", label: "Duration", sort: "duration", numeric: true, title: "Flow end time minus start time. (open): still open at the end of the searched range, so how long it had been open" },
  { key: "retx_pkts", label: "Retx Pkts", sort: "retx_pkts", numeric: true, title: "TCP packets retransmitted, both directions (hover a cell for each direction). \"keepalive\": 1-byte keepalive probes, which the ION counts as retransmits but are not lost data; sorting uses the rest" },
  { key: "retx_pct", label: "Retx %", sort: "retx_pct", numeric: true, title: "Retransmitted packets as a share of all the flow's packets (TCP), leaving out keepalive probes" },
  { key: "retx_bytes", label: "Retx Bytes", sort: "retx_bytes", numeric: true, title: "TCP bytes retransmitted, both directions (hover a cell for each direction)" },
  { key: "jitter", label: "Jitter", sort: "jitter", numeric: true, title: "Average jitter, worse direction (hover for both). Only for media the ION can measure; encrypted media such as Teams shows -" },
  { key: "loss", label: "Loss", sort: "loss", numeric: true, title: "Average packet loss, worse direction (hover for both). Only for media the ION can measure" },
  { key: "mos", label: "MOS", sort: "mos", numeric: true, title: "Average MOS (call quality, 1-5), worse direction (hover for both). Only for media the ION can measure" },
  { key: "action", label: "Action", sort: "flow_action", title: "Flow action; dropped flows show why (from the path decision and security policy on the record). Hover for details" },
  { key: "end_reason", label: "End Reason", sort: "session_end_reason", title: "Session end reason, e.g. tcp-fin, aged-out, tcp-rst-from-client. n/a: not reported (ION software before 6.8)" },
  { key: "init_success", label: "Init OK", sort: "init_success", pill: true, title: "Init Success: whether connection setup completed (TCP handshake). Blank where it does not apply, e.g. UDP/ICMP" },
  { key: "return_traffic", label: "Return", sort: "return_traffic", pill: true, title: "Return Traffic. Yes: data came back from the server. Reset: the server only sent a TCP reset (refused). SYN-ACK only: the server accepted but the handshake never completed. No: forwarded, but nothing came back. Dropped: the ION dropped the flow (see Action). See HELP" },
  { key: "security", label: "Security", sort: null, pill: true },
];
export const COLUMN_KEYS = COLUMNS.map((c) => c.key);

// Column groups, toggled by buttons (on the toolbar while hidden, above their columns while shown).
export const GROUPS = {
  user: { label: "UserID", cols: ["user"], what: "User column" },
  app: { label: "AppStats", cols: ["rtt", "srt", "udp_trt"], what: "Avg RTT, Avg SRT and Avg UDP TRT columns" },
  policy: { label: "Policy", cols: ["path_policy", "qos_policy", "security_policy"], what: "Path, QoS and Security Policy columns" },
  quality: { label: "Voice", cols: ["jitter", "loss", "mos"], what: "Jitter, Loss and MOS columns (voice/video the ION can measure)" },
  flowstats: { label: "TotalFlowStats", cols: ["bytes_total", "packets_total"], what: "Total Bytes and Total Packets columns" },
  directional: { label: "DirectionalFlowStats", cols: ["bytes_c2s", "bytes_s2c", "packets_c2s", "packets_s2c"], what: "Bytes C2S/S2C and Packets C2S/S2C columns" },
  retransmits: { label: "Retransmits", cols: ["retx_pkts", "retx_pct", "retx_bytes"], what: "Retx Pkts, Retx % and Retx Bytes columns (TCP)" },
  pathchange: { label: "Path Change", cols: ["path_change", "assurance"], what: "Path Change and Assurance (Flow Move) columns" },
  duration: { label: "Duration", cols: ["duration"], what: "Duration column" },
  action: { label: "Action", cols: ["action"], what: "Action column" },
  endreason: { label: "End Reason", cols: ["end_reason"], what: "End Reason column" },
};
export const GROUP_ORDER = ["user", "app", "policy", "quality", "flowstats", "directional", "retransmits", "pathchange", "duration", "action", "endreason"];
// Shown until the columns are changed, and again after DEFAULT FILTER RESET.
export const DEFAULT_COLUMNS = ["site", "time", "source_ip", "source_port", "destination_ip", "destination_port", "protocol", "app",
  "domain", "path", "init_success", "return_traffic", "security"];
export const defaultHidden = () => Object.fromEntries(COLUMN_KEYS.filter((k) => !DEFAULT_COLUMNS.includes(k)).map((k) => [k, true]));

// A saved column layout, cleaned: columns that no longer exist dropped; null -> the defaults.
export function loadHidden(saved) {
  if (!saved || typeof saved !== "object") return defaultHidden();
  return Object.fromEntries(Object.entries(saved).filter(([k, v]) => COLUMN_KEYS.includes(k) && v));
}

// The table head's group row: the visible columns in runs, each a fully shown group (its button spans
// it) or other columns. A group whose columns aren't adjacent gets a button over each run.
export function groupRuns(visibleKeys, hidden) {
  const groupOf = {};
  for (const [g, def] of Object.entries(GROUPS)) {
    if (def.cols.every((k) => !hidden[k])) for (const k of def.cols) groupOf[k] = g;
  }
  const runs = [];
  for (const key of visibleKeys) {
    const group = groupOf[key] || null;
    const last = runs[runs.length - 1];
    if (last && last.group === group) last.span++;
    else runs.push({ group, span: 1, key });
  }
  return runs;
}

// The value a column shows for a flow: what its filter lists and matches, and the CSV's default.
export function columnValue(names, key, f) {
  switch (key) {
    case "site": return f._site_name || "-";
    case "time": return formatTime(f.flow_start_time_ms);
    case "source_ip": return f.source_ip || "-";
    case "user": return f.user_name || "-";
    case "source_port": return String(f.source_port || "-");
    case "destination_ip": return f.destination_ip || "-";
    case "destination_port": return String(f.destination_port || "-");
    case "protocol": return protocolName(f.protocol);
    case "app": return appName(names, f.app_id);
    case "domain": return f.unknown_domain || "-";
    case "path_policy": return networkPolicy(names, f);
    case "qos_policy": return priorityPolicy(names, f);
    case "security_policy": return securityPolicy(names, f);
    case "direction": return formatDirection(f.flow_direction);
    case "path": return pathName(names, f);
    case "path_change": return f.wan_path_change_reason || "-";
    case "assurance": return f.is_move_flow ? "Flow Move" : "-";
    case "rtt": return formatMs(flowRtt(f));
    case "srt": return formatMs(f.average_srt);
    case "udp_trt": return formatMs(f.average_udp_trt);
    case "bytes_c2s": return formatBytes(f.bytes_c2s || 0);
    case "bytes_s2c": return formatBytes(f.bytes_s2c || 0);
    case "bytes_total": return formatBytes(totalBytes(f));
    case "packets_c2s": return formatCount(f.packets_c2s);
    case "packets_s2c": return formatCount(f.packets_s2c);
    case "packets_total": return formatCount(totalPackets(f));
    case "duration": {
      const text = formatDuration(flowDuration(f));
      return flowOpen(f) && text !== "-" ? `${text} (open)` : text;
    }
    case "retx_pkts": return retxPktsText(f);
    case "retx_pct": { const v = retxPct(f); return v == null ? "-" : `${v > 0 && v < 0.1 ? "<0.1" : v.toFixed(v < 10 ? 1 : 0)}%`; }
    case "retx_bytes": { const n = retxSum(f, "retransmit_bytes"); return n == null ? "-" : formatBytes(n); }
    case "jitter": return formatMs(worseDirection(f, "avg_jitter", Math.max));
    case "loss": { const v = worseDirection(f, "avg_packet_loss", Math.max); return v == null ? "-" : `${v.toFixed(2)}%`; }
    case "mos": { const v = worseDirection(f, "avg_mos", Math.min); return v == null ? "-" : v.toFixed(2); }
    case "action": return [f.flow_action || "-", dropReason(names, f)?.text].filter(Boolean).join(" · ");
    case "end_reason": return endReasonText(f);
    case "init_success": return initSuccessText(f);
    case "return_traffic": return returnTraffic(f);
    case "security": return securityActions(f).join(", ") || "-";
    default: return "";
  }
}

// IPv4 -> a number, so 9.x sorts before 10.x; anything else (IPv6) sorts as text.
export function ipSortKey(ip) {
  if (!ip) return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4] : ip;
}

// A flow's sort key for a column's sort field; null sorts last either way.
export function sortValue(names, f, field) {
  const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
  const shown = (key) => { const t = columnValue(names, key, f); return t === "-" ? null : t; };
  switch (field) {
    case "bytes_c2s": case "bytes_s2c": case "packets_c2s": case "packets_s2c": return num(f[field]) ?? 0;
    case "bytes_total": return totalBytes(f);
    case "packets_total": return totalPackets(f);
    case "duration": return flowDuration(f);
    case "retx_pkts": return retxReal(f);
    case "retx_bytes": return retxSum(f, "retransmit_bytes");
    case "retx_pct": return retxPct(f);
    case "jitter": return worseDirection(f, "avg_jitter", Math.max);
    case "loss": return worseDirection(f, "avg_packet_loss", Math.max);
    case "mos": return worseDirection(f, "avg_mos", Math.min);
    case "init_success": case "return_traffic": return shown(field);
    case "app_name": return f.app_id ? appName(names, f.app_id) : null;
    case "path": case "path_policy": case "qos_policy": case "security_policy": return shown(field);
    case "source_ip": case "destination_ip": return ipSortKey(f[field]);
    case "flow_start_time_ms": case "source_port": case "destination_port": case "protocol":
    case "average_srt": case "average_udp_trt": return num(f[field]);
    case "average_rtt": return num(flowRtt(f));
    default: { const v = f[field]; return v === null || v === undefined || v === "" ? null : v; }
  }
}

export function sortFlows(names, flows, field, direction) {
  const dir = direction === "asc" ? 1 : -1;
  return flows.map((flow) => ({ flow, key: sortValue(names, flow, field) }))
    .sort((a, b) => {
      const am = a.key === null, bm = b.key === null;
      if (am || bm) return am === bm ? 0 : am ? 1 : -1;
      if (typeof a.key === "number" && typeof b.key === "number") return (a.key - b.key) * dir;
      return collator.compare(String(a.key), String(b.key)) * dir;
    })
    .map((x) => x.flow);
}

// The IP text filter (a whole IPv4 address matches exactly, anything else as part of one) and the
// column filters ({key: [allowed values]}, only for shown columns); skip leaves those columns' filters out.
export function applyFilters(names, flows, view, shownKeys, skip = []) {
  let out = flows;
  const q = (view.ipFilter || "").trim().toLowerCase();
  if (q) {
    const whole = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(q);
    const match = (ip) => { const v = (ip || "").toLowerCase(); return whole ? v === q : v.includes(q); };
    out = out.filter((f) => {
      if (view.ipFilterMode === "src") return match(f.source_ip);
      if (view.ipFilterMode === "dst") return match(f.destination_ip);
      return match(f.source_ip) || match(f.destination_ip);
    });
  }
  const active = Object.entries(view.colFilters || {})
    .filter(([key]) => !skip.includes(key) && shownKeys.includes(key))
    .map(([key, values]) => [key, new Set(values)]);
  if (active.length) out = out.filter((f) => active.every(([key, allowed]) => allowed.has(columnValue(names, key, f))));
  return out;
}

// A column filter's list: each value under the other filters with its count, plus the values selected
// now (count 0 if gone), so they can be unchecked.
export function filterValues(names, flows, key, current) {
  const counts = new Map();
  for (const f of flows) {
    const v = columnValue(names, key, f);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  for (const v of current || []) if (!counts.has(v)) counts.set(v, 0);
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => collator.compare(a.value, b.value));
}

// ---- summaries (Domains / Apps) -------------------------------------------------------------------

// Organization of a domain: its registrable part (maps.google.com -> google.com, news.bbc.co.uk ->
// bbc.co.uk for common two-part country suffixes). IPs stay as they are.
const TWO_PART_SUFFIX = /^(co|com|net|org|gov|edu|ac|or|ne|go|gob|mil|nic|ltd|plc)\.[a-z]{2}$/;
export function orgDomain(domain) {
  const d = domain.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(d) || d.includes(":")) return d;
  const labels = d.split(".");
  if (labels.length <= 2) return d;
  return labels.slice(-(TWO_PART_SUFFIX.test(labels.slice(-2).join(".")) ? 3 : 2)).join(".");
}

const NO_DOMAIN = "(no domain)";
// Each mode: skip = column filters the summary ignores (so filtering the table from it doesn't shrink
// it); group / sub = a flow's group and sub-row (group null: not counted); filters = the column
// filters that show a group's or sub-row's flows (null clears one).
export const SUMMARIES = {
  domains: {
    title: "Domains", groupHead: "Organization", subHead: "Subdomains", search: "Search domains…", skip: ["domain"],
    group: (names, f) => (f.unknown_domain ? orgDomain(f.unknown_domain) : null),
    groupLabel: (org) => (org.includes(".") && !/^[\d.]+$/.test(org) ? `*.${org}` : org),
    sub: (names, f) => f.unknown_domain,
    filters: (g, s) => ({ domain: s ? [s.name] : g.subs.map((x) => x.name) }),
    note: (d, subs) => `${d.groups.length.toLocaleString()} organization${d.groups.length === 1 ? "" : "s"} · ${subs.toLocaleString()} domain${subs === 1 ? "" : "s"} · ` +
      `${d.counted.toLocaleString()} of ${d.flows.toLocaleString()} flows have a detected domain. Click an organization to see its subdomains.`,
  },
  apps: {
    title: "Applications", groupHead: "Application", subHead: "Domains", search: "Search apps and domains…", skip: ["app", "domain"],
    group: (names, f) => appName(names, f.app_id),
    groupLabel: (name) => (name === "-" ? "(unknown app)" : name),
    sub: (names, f) => f.unknown_domain || NO_DOMAIN,
    filters: (g, s) => ({ app: [g.key], domain: s ? [s.name === NO_DOMAIN ? "-" : s.name] : null }),
    note: (d) => `${d.groups.length.toLocaleString()} application${d.groups.length === 1 ? "" : "s"} in ${d.flows.toLocaleString()} flows. Click an application to see the domains seen for it.`,
    noCopy: NO_DOMAIN,
  },
};

export function summarize(names, mode, flows) {
  const cfg = SUMMARIES[mode];
  const groups = new Map();
  let counted = 0;
  for (const f of flows) {
    const key = cfg.group(names, f);
    if (key == null) continue;
    counted++;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label: cfg.groupLabel(key), flows: 0, bytes: 0, subMap: new Map() }));
    const bytes = totalBytes(f);
    g.flows++; g.bytes += bytes;
    const name = cfg.sub(names, f);
    let s = g.subMap.get(name);
    if (!s) g.subMap.set(name, (s = { name, flows: 0, bytes: 0 }));
    s.flows++; s.bytes += bytes;
  }
  return { flows: flows.length, counted, groups: [...groups.values()].map(({ subMap, ...g }) => ({ ...g, subs: [...subMap.values()] })) };
}

// Groups matching the search (by label: all its sub-rows; else the matching sub-rows), sorted.
export function summaryRows(data, search, by) {
  const q = search.trim().toLowerCase();
  const cmp = (key) => (by === "name" ? (a, b) => collator.compare(a[key], b[key]) : (a, b) => b[by] - a[by] || collator.compare(a[key], b[key]));
  return (data?.groups || [])
    .map((g) => ({ ...g, subs: [...(q && !g.label.toLowerCase().includes(q) ? g.subs.filter((s) => s.name.toLowerCase().includes(q)) : g.subs)].sort(cmp("name")) }))
    .filter((g) => g.subs.length)
    .sort(cmp("label"));
}

// ---- CSV ------------------------------------------------------------------------------------------

// The shown columns, with the table's values ('-' as empty) except raw numbers for bytes, packets and
// ms, and extra columns for what the table shows on a second line or in a tooltip.
export function csvText(names, flows, visibleKeys) {
  const ms = (v) => (v != null ? Math.round(v) : "");
  const CSV = {
    protocol: ["Protocol"],
    rtt: ["RTT (avg ms)", (f) => ms(flowRtt(f))],
    srt: ["SRT (avg ms)", (f) => ms(f.average_srt)],
    udp_trt: ["UDP TRT (avg ms)", (f) => ms(f.average_udp_trt)],
    bytes_c2s: ["Bytes C2S", (f) => f.bytes_c2s || 0],
    bytes_s2c: ["Bytes S2C", (f) => f.bytes_s2c || 0],
    bytes_total: ["Total Bytes", totalBytes],
    packets_c2s: ["Packets C2S", (f) => f.packets_c2s || 0],
    packets_s2c: ["Packets S2C", (f) => f.packets_s2c || 0],
    packets_total: ["Total Packets", totalPackets],
    duration: ["Duration (s)", (f) => { const d = flowDuration(f); return d == null ? "" : d / 1000; }],
    retx_pkts: ["Retx Packets", (f) => retxSum(f, "retransmit_pkts") ?? ""],
    retx_pct: ["Retx %", (f) => { const v = retxPct(f); return v == null ? "" : v.toFixed(2); }],
    retx_bytes: ["Retx Bytes", (f) => retxSum(f, "retransmit_bytes") ?? ""],
    action: ["Action", (f) => f.flow_action || ""],
    security: ["Security Action"],
  };
  const EXTRA = {
    path_change: [["Path Before Change", (f) => previousPath(names, f)?.name || ""]],
    assurance: [["Moved From", (f) => moveInfo(names, f)?.from?.name || ""],
      ["Move Reason", (f) => moveInfo(names, f)?.avoided.map((a) => `${a.name}: ${a.reasons.join(", ")}`).join("; ") || ""]],
    duration: [["Still Open", (f) => (flowOpen(f) ? "Yes" : "")]],
    retx_pkts: [["Retx Keepalive Probes", (f) => (retxSum(f, "retransmit_pkts") == null ? "" : retxProbes(f))]],
    action: [["Drop Reason", (f) => dropReason(names, f)?.text || ""]],
  };
  const label = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
  const fields = visibleKeys.flatMap((key) => {
    const [head, get] = CSV[key] || [];
    return [[head || label[key], get || ((f) => { const v = columnValue(names, key, f); return v === "-" ? "" : v; })], ...(EXTRA[key] || [])];
  });
  const esc = (val) => {
    const s = String(val ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.map(([h]) => esc(h)).join(","), ...flows.map((f) => fields.map(([, get]) => esc(get(f))).join(","))].join("\n");
}

// ---- the API query a search sends ------------------------------------------------------------------

// What the server sends for the newest window, page 1 (one per site, and per direction for "either").
export function apiQuery(search, pageSize = 1000) {
  const end = search.end_time || "";
  let start = search.start_time || "";
  if (end && start) {
    const hour = new Date(end);
    hour.setUTCMinutes(0, 0, 0);
    if (hour.getTime() === new Date(end).getTime()) hour.setUTCHours(hour.getUTCHours() - 1);
    if (hour > new Date(start)) start = hour.toISOString();
  }
  const build = (ipField) => {
    const flow = {};
    if (ipField) flow[ipField] = [search.ip_address];
    if (search.dest_ports?.length) flow.destination_port = [...search.dest_ports];
    if (search.protocol) flow.protocol = search.protocol;
    return {
      start_time: start, end_time: end, debug_level: "all", page_size: pageSize, dest_page: 1, view: { summary: false },
      filter: { site: [...(search.site_ids || [])], ...(search.app_ids?.length ? { app: [...search.app_ids] } : {}),
        ...(Object.keys(flow).length ? { flow } : {}) },
    };
  };
  if (!search.ip_address) return build(null);
  if (search.ip_mode === "either") return [build("source_ip"), build("destination_ip")];
  return build(search.ip_mode === "dest" ? "destination_ip" : "source_ip");
}

// ---- time range ------------------------------------------------------------------------------------

export const LAST_BUTTONS = [[5, "5m"], [15, "15m"], [60, "1h"], [240, "4h"], [480, "8h"], [1440, "24h"]];
export const UNFILTERED_MAX_MIN = 240;  // longer searches need an app or IP filter (the server checks too)
export const MAX_AGE_DAYS = 90;         // flow history is supported this far back (the server checks too)
export const tooOld = (start, nowMs = Date.now()) => !isNaN(start) && start.getTime() < nowMs - MAX_AGE_DAYS * 86400e3;

export function localInput(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// 5 -> "5 min", 60 -> "1 h", 90 -> "1 h 30 min".
export function durationText(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
// "Today 13:00 – 14:00", "Yesterday 23:00 – Today 01:00", "Mon, Oct 19 09:00 – 10:00".
export function rangeText(start, end, now = new Date()) {
  const day = (d) => {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86400000);
    return diff === 0 ? "Today" : diff === -1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  };
  const time = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${day(start)} ${time(start)} – ${start.toDateString() === end.toDateString() ? "" : `${day(end)} `}${time(end)}`;
}
export const endsNow = (end, nowMs = Date.now()) => !isNaN(end) && Math.abs(nowMs - end.getTime()) < 10 * 60000;
// Under the range: "Today 13:00 – 14:00 · 1 h · ended 3 h ago".
export function rangeSummary(start, end, nowMs = Date.now()) {
  if (isNaN(start) || isNaN(end) || end <= start) return "";
  const agoMins = Math.round((nowMs - end) / 60000);
  const ago = agoMins < 90 ? `${agoMins} min` : agoMins < 2880 ? `${Math.round(agoMins / 60)} h` : `${Math.round(agoMins / 1440)} days`;
  const when = endsNow(end, nowMs) ? "up to now" : agoMins > 0 ? `ended ${ago} ago` : "in the future";
  return `${rangeText(start, end, new Date(nowMs))} · ${durationText(Math.round((end - start) / 60000))} · ${when}`;
}
// ◀ ▶: the range moved by its own length; forward stops at now. [start, end] or null.
export function stepRange(start, end, dir, nowMs = Date.now()) {
  const len = end - start;
  if (isNaN(len) || len <= 0) return null;
  let s = new Date(start.getTime() + dir * len), e = new Date(end.getTime() + dir * len);
  if (e.getTime() > nowMs) { e = new Date(nowMs); s = new Date(nowMs - len); }
  return [s, e];
}
// Destination ports typed as "443, 8443" (commas or spaces); null if any isn't a port.
export function parsePorts(text) {
  const ports = String(text || "").split(/[\s,]+/).filter(Boolean).map(Number);
  return ports.every((n) => Number.isInteger(n) && n >= 1 && n <= 65535) ? [...new Set(ports)] : null;
}

// ---- progress ----------------------------------------------------------------------------------------

const minsText = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
// "Estimated about 1.2M flows in total, up to 1 h 40 min more (…)".
export function estimateText(e) {
  if (!e) return "";
  const n = e.flows >= 1e6 ? `${(e.flows / 1e6).toFixed(1)}M` : e.flows >= 1e4 ? `${Math.round(e.flows / 1000)}k` : e.flows.toLocaleString();
  return `Estimated about ${n} flows in total, up to ${minsText(e.seconds * 1000)} more (less if hours come from the cache).`;
}
export const progressPercent = (p) => (p.windowsTotal ? Math.min(100, Math.round((p.windowsDone / p.windowsTotal) * 100)) : 0);
// "12 of 48 hourly windows done, 2 being read (26%) · 6 min elapsed · up to 18 min left"
export function progressText(p, elapsedMs, paused, estimate) {
  let text = `${Math.floor(p.windowsDone)} of ${p.windowsTotal} hourly windows done${p.windowsActive ? `, ${p.windowsActive} being read` : ""}` +
    ` (${progressPercent(p)}%) · ${minsText(elapsedMs)} elapsed`;
  if (paused) text += " · paused";
  else if (estimate) text += ` · up to ${minsText(estimate.seconds * 1000)} left`;
  return text;
}

// ---- deep links ---------------------------------------------------------------------------------------

// /flows?site=<id|name>&app=<id|name>&start=<ISO>&end=<ISO>&ip=<addr>&ipmode=<source|dest|either>
//   &filter=<init_failed|no_return>&run=1. Without a start: the last 24 hours when an app or IP narrows
// the search, else the last hour (longer unfiltered searches are refused).
// Without start and end, the range is the last `last` minutes (1 h, or 24 h with an app or IP filter)
// counted when the link is opened, so a link rendered a while ago still searches up to now.
export function flowsUrl({ site, app, start, end, last, ip, ipmode, filter }) {
  const p = new URLSearchParams();
  if (site) p.set("site", site);
  if (app) p.set("app", app);
  if (ip) p.set("ip", ip);
  if (ipmode) p.set("ipmode", ipmode);
  if (start != null && end != null) {
    p.set("start", new Date(start).toISOString());
    p.set("end", new Date(end).toISOString());
  } else {
    p.set("last", String(last || (app || ip ? 1440 : 60)));
  }
  if (filter) p.set("filter", filter);
  p.set("run", "1");
  return `/flows?${p}`;
}

// A deep link's search: ids picked from lists by id or name (case-insensitive). null without parameters.
export function readDeepLink(search, sites, apps) {
  const p = new URLSearchParams(search);
  if (![...p.keys()].length) return null;
  const pick = (list, value) => {
    const v = String(value).toLowerCase();
    return (list.find((x) => String(x.id) === value) || list.find((x) => x.name.toLowerCase() === v))?.id ?? null;
  };
  const ids = (list, key) => [...new Set(p.getAll(key).map((v) => pick(list, v)).filter((x) => x != null))];
  const date = (key) => { const d = p.get(key) ? new Date(p.get(key)) : null; return d && !isNaN(d) ? d : null; };
  return {
    sites: ids(sites, "site"), apps: ids(apps, "app"), start: date("start"), end: date("end"),
    last: Number(p.get("last")) > 0 ? Math.round(Number(p.get("last"))) : null,
    ip: p.get("ip") || "", ipMode: IP_MODES_UI.includes(p.get("ipmode")) ? p.get("ipmode") : null,
    filter: { init_failed: "init_success", no_return: "return_traffic" }[p.get("filter")] || null,
    run: p.get("run") === "1",
  };
}
const IP_MODES_UI = ["source", "dest", "either"];
