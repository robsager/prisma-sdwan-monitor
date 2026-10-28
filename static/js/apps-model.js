// Top applications, its Details dialog and the app connection-failure alarms, free of the DOM.
//
// snap = the server's /top-apps response for the open site and period:
//   { apps: [...] | null, status, error, progress, start_time, end_time, generated_at, window_hours,
//     next_refresh_at, refresh_ready_at,
//     rtt: {state, covered, failed, error, fetched_at, start_time, end_time}, unreachable: {...} }
// RTT and app unreachable are fetched only when their button is pressed: a rebuilt list keeps what
// was loaded, with its own time.

import { ageText, fmt, minuteLabel } from "./format.js";
import { STATUS_LABEL, THRESHOLDS, status } from "./overview-model.js";

export const TOP_APPS_POLL_MS = 30 * 60 * 1000; // the server rebuilds a list after 30 minutes
export const APPS_FAST_MS = 3000;               // while a job runs
export const APPS_ERROR_MS = 60000;             // after a failed list (the server retries after a minute)
export const APPS_SHOWN = 25;                   // rows before "Show all"; a filter shows every match
export const APP_PERF_MIN_MINUTES = 30;         // fewer minutes with data: p95 isn't meaningful (faded)
export const SRT_THRESHOLDS = [500, 1000];      // server response time p95, ms
export const RTT_TOP_N = 20, RTT_TOP_DATA = 25;
const RTT_COVERAGE = `the ${RTT_TOP_DATA} apps with the most data and the ${RTT_TOP_N} with the most TCP flows`;
// Apps the controller never records per-prefix events for (verified live), by name.
export const PREFIX_UNTRACKED_APPS = new Set(["ssl", "web-browsing", "unknown"]);
// The manager's own alarm: an app whose failed connections exceed APP_CONN_FAIL_ALARM_PCT of its TCP
// flows over the period, with at least APP_CONN_FAIL_MIN failures so a handful of flows can't trip it.
export const APP_CONN_FAIL_MIN = 20;
export const APP_CONN_FAIL_ALARM_PCT = 50;
export const TXN_BASE_MIN = 100;              // transactions for a normal rate (the server's TXN_BASE_MIN)

// ---- formatting ----------------------------------------------------------------------------------

export const msTxt = (ms) => (ms == null ? "—" : ms >= 1000 ? `${fmt(ms / 1000, 1)} s` : `${fmt(ms, 0)} ms`);
// "842", "31.3k", "1.2M"
export const countTxt = (n) => (n >= 1e6 ? `${fmt(n / 1e6, 1)}M` : n >= 1e4 ? `${fmt(n / 1e3, 0)}k`
  : n >= 1e3 ? `${fmt(n / 1e3, 1)}k` : n.toLocaleString());
// Small volumes read better in MB.
export const sizeTxt = (gb) => (gb == null ? "—" : gb >= 1000 ? `${fmt(gb / 1000, 2)} TB` : gb >= 1 ? `${fmt(gb, 1)} GB`
  : gb >= 0.001 ? `${fmt(gb * 1000, 0)} MB` : gb > 0 ? "<1 MB" : "0");
// Failed connections as a share of the app's TCP flows (handshakes are TCP only); null for UDP-only apps.
export const connPct = (a) => (a.tcp_flows ? (a.failed_connections || 0) / a.tcp_flows * 100 : null);
export const pctTxt = (p) => (p == null ? "—" : p > 0 && p < 0.1 ? "<0.1%" : `${fmt(p, p < 10 ? 1 : 0)}%`);
export const udpFlows = (a) => (a.flows == null ? null : a.flows - (a.tcp_flows || 0));

// A cell: { text, v (a value: bold), st (status colour), muted, faded, tip, sr (screen-reader suffix), trend? }
const cell = (text, extra = {}) => ({ text, v: false, st: null, muted: false, faded: false, tip: "", sr: "", ...extra });
const muted = (text, tip = "") => cell(text, { muted: true, tip });
const flagged = (st) => (st === "warning" || st === "critical" ? ` (${STATUS_LABEL[st].toLowerCase()})` : "");
const valued = (text, st, extra = {}) => cell(text, { v: true, st, sr: flagged(st), ...extra });
// A count: "—" when unknown, a muted 0, else the number (red when bad).
export const countCell = (n, bad = false) => (n == null ? muted("—") : !n ? muted("0") : bad ? valued(n.toLocaleString(), "critical") : cell(n.toLocaleString()));
const failedCell = (what, err) => cell("▲", { v: true, st: "warning", tip: `${what} query failed: ${err}`, sr: `${what} query failed` });

// ---- table columns -------------------------------------------------------------------------------

function rttTrend(m, hours) {
  if (!m.trend) return null;
  const change = m.recent_avg - m.base_avg;
  const pct = m.base_avg ? Math.round((change / m.base_avg) * 100) : null;
  const sign = change >= 0 ? "+" : "−";
  const tip = `Last hour avg ${msTxt(m.recent_avg)} (${m.recent_minutes} min) vs the rest of the ${hours} h ${msTxt(m.base_avg)}: `
    + `${sign}${msTxt(Math.abs(change))}${pct == null ? "" : ` (${sign}${Math.abs(pct)}%)`}`
    + (m.trend === "steady" ? " — steady (under 10 ms or 20%)" : m.trend === "up" ? " — rising" : " — falling");
  const [icon, st, sr] = { up: ["↑", "warning", "rising"], down: ["↓", "good", "falling"], steady: ["→", null, "steady"] }[m.trend];
  return { icon, st, muted: !st, tip, sr };
}

function rttCell(a, hours) {
  if (a.rtt_error) return failedCell("RTT", a.rtt_error);
  if (a.rtt === undefined) return muted("—", `Not fetched: RTT is queried for ${RTT_COVERAGE} (Details has it for any app)`);
  if (!a.rtt) return muted("—", `No RTT samples in the ${hours} h: not reported for this app`);
  const m = a.rtt, low = m.minutes < APP_PERF_MIN_MINUTES;
  const tip = `p95 ${msTxt(m.p95)} · avg ${msTxt(m.avg)} · peak ${msTxt(m.peak)} at ${minuteLabel(m.peak_time)} · ${m.minutes} min with data${low ? " (too few for a reliable p95)" : ""}`;
  return valued(msTxt(m.p95), status(m.p95, THRESHOLDS.latency_ms), { faded: low, tip, trend: rttTrend(m, hours) });
}

function rtt5Cell(a) {
  const m = a.rtt;
  if (!m || m.last5_avg == null) return muted("—");
  return valued(msTxt(m.last5_avg), status(m.last5_avg, THRESHOLDS.latency_ms),
    { tip: `${m.last5_minutes} min with data, ending ${minuteLabel(m.last5_end)}` });
}

function unreachableCell(a) {
  if (a.unreachable_error) return failedCell("App unreachable", a.unreachable_error);
  if (a.app_unreachable === undefined) {
    return muted("—", `Not fetched: App unreachable is queried for ${RTT_COVERAGE} (Details has it for any app)`);
  }
  return countCell(a.app_unreachable, true);
}

function connPctCell(a) {
  const p = connPct(a);
  if (p == null) return muted("—");
  if (!p) return muted("0");
  return valued(pctTxt(p), p >= 10 ? "critical" : p >= 2 ? "warning" : null);
}

// key, label, heading tip, sort value, cell. Low-sample RTT p95s sort below every reliable one,
// but above apps without RTT.
export const APP_COLS = [
  { key: "name", label: "Application", text: true, value: (a) => (a.name || "").toLowerCase(), cell: (a) => cell(a.name, { tip: a.name }) },
  { key: "gb", label: "Data", title: "Both directions, over the selected period", value: (a) => a.gb ?? -1,
    cell: (a) => cell(sizeTxt(a.gb), { tip: a.gb_down == null ? "" : `↓ ${sizeTxt(a.gb_down)} · ↑ ${sizeTxt(a.gb_up)}` }) },
  { key: "gb_down", label: "↓ Down", title: "Download (to the site), over the selected period", value: (a) => a.gb_down ?? -1, cell: (a) => cell(sizeTxt(a.gb_down)) },
  { key: "gb_up", label: "↑ Up", title: "Upload (from the site), over the selected period", value: (a) => a.gb_up ?? -1, cell: (a) => cell(sizeTxt(a.gb_up)) },
  { key: "tcp_flows", label: "TCP flows", value: (a) => a.tcp_flows ?? -1, cell: (a) => countCell(a.tcp_flows) },
  { key: "udp_flows", label: "UDP flows", value: (a) => udpFlows(a) ?? -1, cell: (a) => countCell(udpFlows(a)) },
  { key: "failed_connections", label: "Conn fail", title: "Failed connections over the selected period: the TCP 3-way handshake didn't complete",
    value: (a) => a.failed_connections ?? -1, // not coloured: Conn fail % is the indicator
    cell: (a) => (a.flows != null && !a.tcp_flows ? muted("—", "UDP only: no TCP handshakes to fail") : countCell(a.failed_connections)) },
  { key: "conn_pct", label: "Conn fail %", title: "Failed connections as a share of the app's TCP flows", value: (a) => connPct(a) ?? -1, cell: connPctCell },
  { key: "failed_txn", label: "Failed txn", title: "Failed transactions over the selected period. Every app fails some normally; Details shows the rate against this app's normal",
    value: (a) => a.failed_txn ?? -1, cell: (a) => countCell(a.failed_txn) },
  { key: "unreachable", label: "App unreachable", title: `No TCP ACK for 60 s, over the selected period. Fetched for ${RTT_COVERAGE} (not recorded for ssl, web-browsing or unknown)`,
    value: (a) => a.app_unreachable ?? -1, cell: unreachableCell },
  { key: "rtt5", label: "RTT 5 min", title: "Average RTT over the 5 minutes ending at the newest sample: shows a change (e.g. a path move) that the period's p95 hides. As fresh as the list",
    value: (a) => a.rtt?.last5_avg ?? -1, cell: rtt5Cell },
  { key: "rtt", label: "RTT p95", title: `Network round-trip time to the server, p95 of 1-minute values over the selected period. Fetched for ${RTT_COVERAGE} (TCP only)`,
    value: (a) => (a.rtt ? (a.rtt.minutes < APP_PERF_MIN_MINUTES ? a.rtt.p95 / 1e6 : a.rtt.p95) : -1), cell: rttCell },
];
export const DEFAULT_SORT = { key: "gb", dir: "desc" };
export const validSort = (s) => (s && APP_COLS.some((c) => c.key === s.key) && ["asc", "desc"].includes(s.dir) ? s : DEFAULT_SORT);
// Clicking a heading: the other direction if it's the current one, else largest (or A–Z) first.
export const nextSort = (sort, key) => (sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
  : { key, dir: key === "name" ? "asc" : "desc" });

// The columns shown: RTT and App unreachable only once loaded (or loading) for this list.
export function visibleCols(snap) {
  const on = (e) => e && e.state !== "off";
  return APP_COLS.filter((c) => (c.key === "rtt" || c.key === "rtt5" ? on(snap?.rtt) : c.key === "unreachable" ? on(snap?.unreachable) : true));
}

export function sortApps(apps, { key, dir }) {
  const col = APP_COLS.find((c) => c.key === key) || APP_COLS[1];
  const sign = dir === "asc" ? 1 : -1;
  return [...apps].sort((a, b) => {
    const x = col.value(a), y = col.value(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sign || (b.gb || 0) - (a.gb || 0);
  });
}

// The table's rows: sorted, filtered by name (a filter shows every match; otherwise the first
// `shown` until "Show all"), each with its rank in the server's order (most data first), a bar
// relative to the biggest app, and a cell per column (default: the visible ones of Top applications).
export function appRows(snap, { sort = DEFAULT_SORT, query = "", showAll = false, cols = visibleCols(snap), shown: limit = APPS_SHOWN } = {}) {
  const all = snap?.apps || [];
  const hours = snap?.window_hours ?? 24;
  const q = query.trim().toLowerCase();
  const sorted = sortApps(all, sort);
  const matching = q ? sorted.filter((a) => (a.name || "").toLowerCase().includes(q)) : sorted;
  const shown = q || showAll ? matching : matching.slice(0, limit);
  const rank = new Map(all.map((a, i) => [a.id, i + 1]));
  const max = Math.max(...all.map((a) => a.gb || 0)) || 1;
  const more = matching.length > shown.length ? `Show all ${matching.length} apps`
    : !q && showAll && all.length > limit ? `Show top ${limit}` : null;
  return {
    cols, total: all.length, more, empty: q && !matching.length ? `No apps match “${query.trim()}”.` : null,
    rows: shown.map((a) => ({ id: a.id, name: a.name, rank: rank.get(a.id), bar: Math.max(2, ((a.gb || 0) / max) * 100),
      cells: Object.fromEntries(cols.map((c) => [c.key, c.cell(a, hours)])) })),
  };
}

// ---- the heading: age, progress, buttons and notes -----------------------------------------------

export const countdownText = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ctx = { nowMs, nextPollAt, note (from the last button press) }
export function appsHeader(snap, ctx) {
  const running = snap?.status === "running";
  const hours = snap?.window_hours ?? 24;
  const apps = snap?.apps;
  const out = { running, hours, count: apps?.length ?? null, age: null, buttons: [], progress: null, notes: [] };
  if (snap?.end_time) {
    out.age = {
      text: `updated ${ageText(ctx.nowMs - Date.parse(snap.end_time))}${running ? " · refreshing…" : ""}`,
      tip: `${hours} h ending ${minuteLabel(snap.end_time)}; computed ${minuteLabel(snap.generated_at)}. Refreshed every ${TOP_APPS_POLL_MS / 60000} minutes while this site is open.`,
      next: !running && ctx.nextPollAt ? `next refresh in ${countdownText(ctx.nextPollAt - ctx.nowMs)}` : null,
    };
  }
  const p = running && snap.progress;
  if (p?.phase === "list") {
    const secs = p.started ? Math.max(0, Math.round(ctx.nowMs / 1000 - p.started)) : null;
    const follows = ["rtt", "unreachable"].filter((k) => snap[k]?.state === "pending").map((k) => (k === "rtt" ? "RTT" : "app unreachable"));
    out.progress = [{ indeterminate: true, label: `Refreshing the app list${secs != null ? ` (${secs} s so far, usually 10–20 s)` : ""}${follows.length ? `; ${follows.join(" and ")} follow` : ""}` }];
  } else if (p?.phase === "enrich") {
    out.progress = ["rtt", "unreachable"].filter((k) => p[k]).map((k) => ({
      indeterminate: false, done: p[k].done, total: p[k].total, pct: p[k].total ? Math.round((p[k].done / p[k].total) * 100) : 0,
      label: `Fetching ${k === "rtt" ? "RTT" : "app unreachable"}: ${p[k].done} of ${p[k].total} apps (one query each)`,
    }));
  }
  if (apps?.length) {
    const load = (kind, what) => {
      const e = snap[kind];
      if (!e) return;
      const pending = e.state === "pending", loaded = e.covered != null;
      const cost = `one query per app (${RTT_COVERAGE}${kind === "unreachable" ? ", minus apps it's never recorded for" : ""}): about 30–60 s`;
      out.buttons.push({ kind, label: `${loaded ? "Refresh" : "Load"} ${what}`, prominent: !loaded, disabled: running || pending,
        tip: pending ? `Fetching ${what}…` : running ? "A refresh is already running for this list; try again once it finishes"
          : loaded ? `Fetch ${what} again for the list's ${hours} h: ${cost}. It's only fetched when you press this`
            : `${what[0].toUpperCase()}${what.slice(1)} needs ${cost}. It's only fetched when you press this; after that it stays as loaded (with its time) until you refresh it` });
    };
    load("rtt", "RTT");
    load("unreachable", "app unreachable");
    if (!running) {
      const cooldown = snap.refresh_ready_at ? Date.parse(snap.refresh_ready_at) - ctx.nowMs : 0;
      out.buttons.push({ kind: "refresh", label: "Refresh now", prominent: false, disabled: cooldown > 0,
        tip: cooldown > 0 ? `Refreshed less than a minute ago; try again in ${Math.ceil(cooldown / 1000)} s`
          : `Rebuild the list now for the ${hours} h ending now (RTT and app unreachable stay as loaded); otherwise it refreshes every ${TOP_APPS_POLL_MS / 60000} minutes` });
    }
  }
  if (ctx.note) out.notes.push({ st: null, text: ctx.note });
  if (snap?.status === "error" && apps) {
    out.notes.push({ st: "warning", text: `Refresh failed — showing results from ${minuteLabel(snap.generated_at)}; retrying shortly`, tip: snap.error });
  }
  for (const [kind, what] of [["rtt", "RTT"], ["unreachable", "App unreachable"]]) {
    const e = snap?.[kind];
    const at = e?.fetched_at || (e?.covered != null ? snap.generated_at : null);
    if (at && apps?.length) {
      const end = e.end_time || snap.end_time;
      const older = end && snap.end_time && Date.parse(end) < Date.parse(snap.end_time);
      out.notes.push({ st: null, text: `${what} loaded ${ageText(ctx.nowMs - Date.parse(at))}${older ? `, for the ${hours} h ending ${minuteLabel(end)}` : ""}${e.state === "pending" ? " · refreshing…" : ""}`,
        tip: `${hours} h ending ${minuteLabel(end)}; fetched ${minuteLabel(at)}. Not refreshed on its own: press Refresh ${what === "RTT" ? "RTT" : "app unreachable"}` });
    }
    if (e?.error) out.notes.push({ st: "warning", tip: e.error,
      text: `${what} query failed for ${e.failed} app${e.failed === 1 ? "" : "s"} (shown as ▲); asked again when you refresh it` });
  }
  // What the body shows instead of a table.
  out.state = !snap || (apps == null && snap.status !== "error") ? "loading" : apps == null ? "error" : !apps.length ? "empty" : "table";
  return out;
}

// ---- app connection-failure alarms ---------------------------------------------------------------

export const connAlarmed = (a) => (a.failed_connections || 0) >= APP_CONN_FAIL_MIN && connPct(a) > APP_CONN_FAIL_ALARM_PCT;
export const connAckKey = (tsg, siteId, appId) => `${tsg}|${siteId}|${appId}`;

// Shaped like the controller's alarms (site-health-model's activeAlarms), marked generated.
export function connAlarms(snap, { tsg, siteId, acks = {} }) {
  const hours = snap?.window_hours ?? 24;
  return (snap?.apps || []).filter(connAlarmed).sort((a, b) => connPct(b) - connPct(a)).map((a) => {
    const ackKey = connAckKey(tsg, siteId, a.id);
    return {
      id: `app-conn:${a.id}`, code: "APP_CONNECTION_FAILURES_HIGH", severity: "major", generated: true,
      entity_type: "apps", entity_id: a.id, app: a.name, time: snap.end_time, window_hours: hours,
      info_text: `${pctTxt(connPct(a))} of ${a.tcp_flows.toLocaleString()} TCP flows failed to connect (${a.failed_connections.toLocaleString()} failed), last ${hours} h`,
      ack_key: ackKey, acknowledged: !!acks[ackKey], acked_at: acks[ackKey] || null,
    };
  });
}

// Acknowledgements last while the alarm does: once the site's list loads without it, its ack goes,
// so the next time the app goes over the threshold it's unacknowledged again. -> the acks to keep.
export function pruneAcks(acks, snap, { tsg, siteId }) {
  if (!snap?.apps) return acks;
  const prefix = connAckKey(tsg, siteId, "");
  const live = new Set(snap.apps.filter(connAlarmed).map((a) => connAckKey(tsg, siteId, a.id)));
  return Object.fromEntries(Object.entries(acks).filter(([k]) => !k.startsWith(prefix) || live.has(k)));
}

// ---- Details dialog ------------------------------------------------------------------------------

function perfRow(label, m, th, err) {
  if (err) return { label, error: `${label} query failed: ${err}` };
  if (!m) return { label, none: true };
  const low = m.minutes < APP_PERF_MIN_MINUTES;
  return { label, p95: valued(msTxt(m.p95), status(m.p95, th), { faded: low }), avg: msTxt(m.avg),
    peak: msTxt(m.peak), peakTime: minuteLabel(m.peak_time), minutes: `${m.minutes} min${low ? " (low sample)" : ""}` };
}

// app = the app's row from the list (or {id, name}); d = /apps/<id>; hours = the dialog's period.
export function appDetailView(d, app, hours) {
  const unreach = d.prefix_error ? { value: failedCell("Per-prefix events", d.prefix_error), sub: "query failed" }
    : PREFIX_UNTRACKED_APPS.has(app.name) ? { value: muted("—"), sub: "not recorded for this app" }
      : d.prefix_events ? { value: countCell(d.app_unreachable, true), sub: "no TCP ACK for 60 s" }
        : { value: muted("—"), sub: "none recorded (or prefix tracking off)" };
  const listed = app.flows !== undefined; // else the list for this period is still loading
  const tiles = !listed ? ["Data", "Flows", "Failed connections", "Failed transactions"].map((label) => ({ label, value: muted("—"), sub: "loading the list…" })) : [
    app.gb === undefined ? { label: "Data", value: muted("—"), sub: "not reported per site" } // from the Overview's app sites
      : { label: "Data", value: cell(sizeTxt(app.gb)), sub: app.gb_down == null ? "" : `↓ ${sizeTxt(app.gb_down)} · ↑ ${sizeTxt(app.gb_up)}` },
    { label: "Flows", value: cell(countTxt(app.flows ?? 0)), sub: `TCP ${(app.tcp_flows ?? 0).toLocaleString()} · UDP ${(udpFlows(app) ?? 0).toLocaleString()}` },
    { label: "Failed connections", value: countCell(app.failed_connections, true), sub: connPct(app) == null ? "UDP only: no handshakes" : `${pctTxt(connPct(app))} of TCP flows` },
    { label: "Failed transactions", value: countCell(app.failed_txn), sub: "as in the table" },
  ];
  tiles.push({ label: "App unreachable", ...unreach });
  // Failed transactions: the app's normal (the period before the last hour) against the last hour.
  let txn = null;
  if (!d.perf_error) {
    const t = d.txn;
    txn = !t ? { none: true } : {
      rows: [
        // The whole period first: the two rows below are often "—" for a quiet app (too few for a normal rate, none in the last hour).
        { label: `All ${hours} h`, failed: d.failures ?? 0, total: d.transactions || null, pct: t.pct },
        // Its counts always show; its rate only from TXN_BASE_MIN transactions (else "too few": not a normal to compare with).
        { label: hours > 1 ? `Previous ${hours - 1} h (normal)` : "Earlier (normal)",
          failed: (d.failures ?? 0) - t.recent_failures, total: (d.transactions || 0) - t.recent_transactions || null,
          pct: t.base_pct, tooFew: t.base_pct == null && (d.transactions || 0) - t.recent_transactions > 0 },
        // None in the last hour is a real 0 (a quiet app), not missing data.
        { label: "Last hour", failed: t.recent_failures ?? 0, total: t.recent_transactions ?? 0, pct: t.recent_pct, none: !t.recent_transactions },
      ].map((r) => ({ label: r.label, failed: r.total == null ? "—" : r.failed.toLocaleString(),
        total: r.total == null ? "—" : r.total.toLocaleString(),
        pct: r.tooFew ? "too few" : r.pct == null ? "—" : `${fmt(r.pct, 1)}%`, pctMuted: !!(r.tooFew || r.none),
        pctTip: r.tooFew ? `Under ${TXN_BASE_MIN} transactions: too few for a normal rate to compare the last hour with`
          : r.none ? "No transactions in the last hour" : "" })),
      flag: t.flagged ? { st: t.recent_pct - (t.base_pct ?? 0) >= 25 ? "critical" : "warning",
        text: `Flagged: the last hour is well above this app's normal rate here (↑ ${fmt(t.recent_pct, 1)}%)` } : null,
      note: `${t.base_pct == null ? "Too few transactions for a normal rate. " : "Within this app's normal rate here. "}Every app fails some transactions normally.`,
    };
  }
  const perf = [
    perfRow("SRT (server response time)", d.srt, SRT_THRESHOLDS, d.perf_error),
    perfRow("RTT (round-trip time)", d.rtt, THRESHOLDS.latency_ms, d.perf_error),
    perfRow("TRT (UDP transaction response time)", d.udp_trt, THRESHOLDS.latency_ms, d.perf_error),
  ];
  return { tiles, txn, perf, prefixEvents: !!d.prefix_events };
}

// The destination prefixes matching the filter, and the count line above them.
export function prefixView(d, query = "") {
  const all = d?.prefixes || [];
  const q = query.trim().toLowerCase();
  const rows = q ? all.filter((p) => p.prefix.toLowerCase().includes(q)) : all;
  const total = (k) => all.reduce((n, p) => n + (p[k] || 0), 0).toLocaleString();
  return {
    count: `${rows.length}${q ? ` of ${all.length}` : ""} destination prefixes · ${total("failed_connections")} failed connections · ${total("app_unreachable")} unreachable · ${total("failed_txn_events")} failed transactions`,
    rows: rows.map((p) => ({ prefix: p.prefix, failed: countCell(p.failed_connections, true), anyFailed: p.failed_connections > 0,
      unreachable: countCell(p.app_unreachable, true), txn: countCell(p.failed_txn_events) })),
  };
}
