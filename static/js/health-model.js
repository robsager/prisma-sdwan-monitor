// The Overview's Health tile and Tenant panel, free of the DOM.
//
// health = the server's /health response: { sites, apps, links: {id: category}, counts: {kind: {good,
//   fair, poor, others, total} | null}, link_names, app_names, errors }. Categories: good | fair | poor,
//   and for apps "others" (too little data), as in SCM's Monitor > Applications.
// apps = the server's /apps response: { apps: [...] | null, status, error, site_count, start_time, end_time }.

import { ageText, hm, minuteLabel } from "./format.js";
import { STATUS_ICON } from "./overview-model.js";
import { APP_COLS, appRows, pctTxt } from "./apps-model.js";

export const HEALTH_POLL_MS = 5 * 60 * 1000;      // the server caches health 5 minutes
export const TENANT_APPS_POLL_MS = 10 * 60 * 1000; // and rebuilds the app list after 10
export const TENANT_APPS_FAST_MS = 3000;           // while it builds one
export const TENANT_APPS_SHOWN = 15;
export const HEALTH_ST = { good: "good", fair: "warning", poor: "critical" };
const KIND_LABEL = { sites: "sites", apps: "apps", links: "links" };

// One tile row ("Sites ● 8 ▲ 1 ✕ 0"): null while unknown, { none } when the controller has none.
export function healthCounts(c) {
  if (!c) return null;
  if (!c.total) return { none: true };
  return { parts: ["good", "fair", "poor"].map((cat) => ({ cat, n: c[cat] || 0, st: c[cat] ? HEALTH_ST[cat] : null, icon: STATUS_ICON[HEALTH_ST[cat]] })) };
}

export function healthTile(entry) {
  const c = entry?.data?.counts;
  const rows = ["sites", "apps", "links"].map((k) => ({ kind: k, label: k[0].toUpperCase() + k.slice(1), counts: healthCounts(c?.[k]),
    failed: entry?.data && c?.[k] === null }));
  const sub = entry?.error && !entry.data ? { st: "warning", text: `Couldn't load: ${entry.error}` }
    : entry?.data ? { st: null, text: "last 3 h · AIOps, as in SCM" } : { st: null, text: "loading…" };
  return { rows, sub };
}

// A site card's "Health fair" / "Health poor" (nothing when good or unknown).
export function siteHealthTag(health, siteId) {
  const cat = health?.sites?.[siteId];
  return cat && cat !== "good" && HEALTH_ST[cat] ? { cat, st: HEALTH_ST[cat] } : null;
}

// The fair and poor sites, links and apps as table rows, poor first: { summary: [{ st, icon, text }]
// (the collapsed heading), rows: [{ key, cat, st, icon, type, name: {text, href?, muted?, title?},
// circuit, to, intervals, cause }], allGood, errors }. siteNames: the Overview's sites {id: name}; a
// site not on it (site filter, data centers hidden) isn't linked. A VPN link starts from its end on
// the Overview. detail: { data, error, busy } of /health/detail, or null while the table is closed:
// intervals are AIOps' own 5-minute categories, cause the Manager's estimate (links only).
const KIND_ORDER = { sites: 0, links: 1, apps: 2 };
const LINK_TYPE = { vpn: "VPN link", direct: "Direct internet", service: "Service link" };

const SLOT_ST = { g: "good", f: "warning", p: "critical" };
const SLOT_CAT = { g: "good", f: "fair", p: "poor", "-": "not scored yet" };

// AIOps' 5-minute categories of one item: { cells: [{ st, tip }], text, tip }.
export function intervalsCell(timeline, slots) {
  const n = (c) => [...timeline].filter((x) => x === c).length;
  const scored = timeline.length - n("-");
  const parts = [["p", "poor"], ["f", "fair"]].filter(([c]) => n(c)).map(([c, w]) => `${n(c)} ${w}`);
  return {
    cells: [...timeline].map((c, i) => ({ st: SLOT_ST[c] || "none", tip: `${slots[i] ? hm(Date.parse(slots[i])) : ""} ${SLOT_CAT[c] || c}` })),
    text: scored ? `${parts.join(", ") || "none bad"} of ${scored}` : "not scored yet",
    tip: `AIOps' rating of each 5-minute interval, oldest first${n("-") ? `; the newest ${n("-") * 5} minutes aren't scored yet` : ""}`,
  };
}

// The Manager's estimate for one link: { state: loading | none | error | ok, lines: [text], note, tip }.
export function causeCell(kind, item, detail, limits, known = true) {
  if (kind === "sites") return { state: "none", lines: [], note: "" };
  if (!detail?.data) return detail?.error ? { state: "error", lines: [], note: "Couldn't load" } : { state: "loading", lines: [], note: "" };
  const c = item?.cause;
  if (kind === "apps") return appCause(c);
  if (!c) return { state: "none", lines: [], note: known ? "Not checked (too many flagged links)" : "Not checked: the topology doesn't know this link" };
  const tip = limits ? `Estimated by this app, not by AIOps: in the link's fair or poor intervals, loss ≥ ${limits.loss} %, `
    + `latency ${limits.latency_jump} ms or more over its median, jitter ≥ ${limits.jitter} ms (and twice its median) or MOS < ${limits.mos}` : "";
  const lines = c.findings.map((f) => f.text);
  const note = c.note || (c.explained < c.bad ? `${c.bad - c.explained} of ${c.bad} bad intervals unexplained` : "");
  return { state: "ok", lines, note, tip };
}

// An app: per fair or poor site, the verdict and what was measured there.
function appCause(c) {
  const sites = c?.sites || [];
  if (!sites.length) return { state: "none", lines: [], note: c ? "No fair or poor site from AIOps" : "Not checked (too many flagged apps)" };
  const many = sites.length > 1;
  const lines = sites.flatMap((s) => [s.verdict, ...s.findings.map((f) => f.text)].filter(Boolean).map((t) => (many ? `${s.site}: ${t}` : t)));
  const note = sites.map((s) => s.note && (many ? `${s.site}: ${s.note}` : s.note)).filter(Boolean).join("; ");
  return { state: "ok", lines, note, verdicts: sites.map((s) => s.verdict).filter(Boolean),
    tip: `Estimated by this app, not by AIOps: the app's response times and transaction failures at ${many ? "each" : "its"} fair or poor site, in its fair and poor intervals` };
}

// The AIOps facts under an app's name: "score 63 · fair at site A · 718 transactions, 0 failed to establish".
export function appAiops(a) {
  if (!a) return null;
  const parts = a.score != null ? [`score ${Math.round(a.score)}`] : [];
  for (const s of a.sites || []) {
    const c = s.counters;
    const n = (v) => Math.round(v || 0).toLocaleString();
    parts.push(`${s.cat} at ${s.name}${c ? ` (${n(c.success_trans)} transactions, ${n(c.fail_to_establish)} failed to establish${c.incomplete_trans ? `, ${n(c.incomplete_trans)} incomplete` : ""})` : ""}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

// Each slot's worst rating across timelines of the same length (p > f > g > "-").
const RANK = { "-": 0, g: 1, f: 2, p: 3 };
export function mergeTimelines(timelines) {
  return [...timelines[0]].map((_, i) => timelines.map((t) => t[i] || "-").reduce((x, y) => (RANK[y] > RANK[x] ? y : x))).join("");
}

function mergeCauses(causes) {
  const ok = causes.filter((c) => c.state === "ok");
  if (!ok.length) return causes[0];
  return { state: "ok", lines: [...new Set(ok.flatMap((c) => c.lines))], note: [...new Set(ok.map((c) => c.note).filter(Boolean))].join("; "), tip: ok[0].tip };
}

export function healthIssues(health, siteNames, detail = null) {
  if (!health) return null;
  const idByName = Object.fromEntries(Object.entries(siteNames).map(([id, name]) => [name, id]));
  const siteCell = (name) => (idByName[name] ? { text: name, href: `#/site/${encodeURIComponent(idByName[name])}` } : { text: name || "Unknown" });
  const far = (e) => (e.circuit && e.circuit !== e.site ? `${e.site} (${e.circuit})` : e.site);
  // One row per site, app and link; a VPN link's tunnels (vpnlinks, which AIOps rates apart: a
  // failover in the window gives two) share one row with the worse category.
  const groups = new Map();
  for (const kind of ["sites", "links", "apps"]) {
    for (const [id, cat] of Object.entries(health[kind] || {})) {
      if (cat !== "fair" && cat !== "poor") continue;
      const link = kind === "links" && health.link_parts?.[id]?.link;
      const key = link ? `links:link:${link}` : `${kind}:${id}`;
      const g = groups.get(key) || { kind, ids: [], cat };
      g.ids.push(id);
      if (cat === "poor") g.cat = "poor";
      groups.set(key, g);
    }
  }
  const rows = [];
  for (const { kind, ids, cat } of groups.values()) {
    ids.sort();
    const id = ids[0];
    const base = { cat, st: HEALTH_ST[cat], icon: STATUS_ICON[HEALTH_ST[cat]] };
    const items = ids.map((i) => detail?.data?.items?.[kind]?.[i]);
    const timeline = items.every(Boolean) ? mergeTimelines(items.map((x) => x.timeline)) : null;
    const causes = ids.map((i, k) => causeCell(kind, items[k], detail, detail?.data?.limits, !!health.link_parts?.[i]));
    const row = { ...base, key: `${kind}:${id}`, kind, circuit: "", to: "", tunnels: ids.length,
      intervals: timeline != null ? intervalsCell(timeline, detail.data.slots) : null,
      cause: causes.length === 1 ? causes[0] : mergeCauses(causes) };
    if (kind === "sites") {
      Object.assign(row, { type: "Site", name: siteNames[id] ? siteCell(siteNames[id]) : { text: id, muted: true, title: "Not on the Overview (site filter)" } });
    } else if (kind === "apps") {
      const name = health.app_names?.[id];
      Object.assign(row, { type: "App", name: name ? { text: name } : { text: id, muted: true, title: "No name for this app" },
        sub: appAiops(items[0]?.aiops) });
    } else {
      const parts = health.link_parts?.[id];
      const name = health.link_names?.[id];
      if (parts) {
        let [a, b] = parts.ends;
        if (b && !idByName[a.site] && idByName[b.site]) [a, b] = [b, a];
        Object.assign(row, { type: LINK_TYPE[parts.kind] || "Link", name: siteCell(a.site), circuit: a.circuit || "",
          to: b ? far(b) : parts.kind === "service" ? parts.far || "" : "Internet" });
        if (ids.length > 1) Object.assign(row, { typeNote: `${ids.length} tunnels`, typeTip: "AIOps rates each tunnel of the link; it changed tunnel in the window, so both are shown together (the worse category, each interval's worse rating)" });
      } else {
        Object.assign(row, { type: "Link", name: name ? { text: name } : { text: id, muted: true, title: "No name for this link" } });
      }
    }
    rows.push(row);
  }
  const summary = [];
  for (const cat of ["poor", "fair"]) {
    for (const kind of ["sites", "links", "apps"]) {
      const n = rows.filter((r) => r.cat === cat && r.kind === kind).length;
      if (!n) continue;
      const st = HEALTH_ST[cat];
      summary.push({ st, icon: STATUS_ICON[st], text: `${n} ${cat} ${n === 1 ? KIND_LABEL[kind].slice(0, -1) : KIND_LABEL[kind]}` });
    }
  }
  const catOrder = { poor: 0, fair: 1 };
  rows.sort((x, y) => catOrder[x.cat] - catOrder[y.cat] || KIND_ORDER[x.kind] - KIND_ORDER[y.kind]
    || x.name.text.localeCompare(y.name.text) || x.circuit.localeCompare(y.circuit));
  const errors = [...(health.errors || []), ...(detail?.data?.errors || []), ...(detail?.error ? [`Details: ${detail.error}`] : [])];
  return { rows, summary, allGood: !rows.length && !(health.errors || []).length, errors,
    // While /health/detail loads (up to a minute cold): nothing yet, or a refresh of what's shown.
    detailLoading: !!detail && !detail.data && !detail.error, detailRefreshing: !!detail?.data && !!detail.busy };
}

// The tenant table's health cell for one app.
export function healthDot(cat) {
  if (HEALTH_ST[cat]) return { text: STATUS_ICON[HEALTH_ST[cat]], st: HEALTH_ST[cat], tip: `AIOps health (last 3 h): ${cat}` };
  return { text: "·", st: null, muted: true, tip: cat === "others" ? "AIOps health: too little data" : "No AIOps health for this app" };
}

// Health filter chips (All / Good / Fair / Poor), counted from the health response.
export function healthChips(counts) {
  if (!counts) return [];
  return [{ key: "all", label: "All", n: counts.total || 0 }, ...["good", "fair", "poor"].map((k) => ({
    key: k, label: k[0].toUpperCase() + k.slice(1), n: counts[k] || 0, st: HEALTH_ST[k] }))];
}

// Columns of the tenant table: Top applications' without RTT and app unreachable (one query per app and site).
export const TENANT_COLS = APP_COLS.filter((c) => !["rtt", "rtt5", "unreachable"].includes(c.key));

// The tenant Applications table: ui = { sort, query, showAll, health: "all" | good | fair | poor }.
export function tenantAppsView(apps, health, ui, nowMs) {
  const all = apps?.apps;
  const cats = health?.apps || {};
  const out = {
    count: all?.length ?? null,
    siteText: apps?.site_count != null ? `${apps.site_count} sites` : "the Overview's sites",
    age: apps?.end_time ? { text: `updated ${ageText(nowMs - Date.parse(apps.end_time))}${apps.status === "running" ? " · refreshing…" : ""}`,
      tip: `24 h ending ${minuteLabel(apps.end_time)}` } : null,
    chips: healthChips(health?.counts?.apps),
    state: all == null ? (apps?.status === "error" ? "error" : "loading") : "table",
    error: apps?.error || "",
  };
  if (all == null) return out;
  const filtered = ui.health === "all" ? all : all.filter((a) => cats[a.id] === ui.health);
  const v = appRows({ apps: filtered, window_hours: 24 }, { sort: ui.sort, query: ui.query, showAll: ui.showAll, cols: TENANT_COLS, shown: TENANT_APPS_SHOWN });
  for (const r of v.rows) r.health = healthDot(cats[r.id]);
  const q = ui.query.trim();
  v.empty = v.rows.length ? null : q ? `No apps match “${q}”.` : ui.health === "all" ? "No apps." : `No ${ui.health} apps (last 3 h).`;
  return { ...out, ...v, refreshFailed: apps.status === "error" };
}

// ---- one app per site (clicking an app) ------------------------------------------------------------

// data = the server's /apps/<id>/sites response: { sites: [{id, name, flows, tcp_flows, failed_connections,
//   failed_txn}] | null, status, error, progress: {done, total}, site_count, end_time }. Columns are Top
// applications' (no GB: the per-site counts come from monitor/metrics, which has no traffic volume).
export const APP_SITES_POLL_MS = 2000;
export const APP_SITES_COLS = ["tcp_flows", "udp_flows", "failed_connections", "conn_pct", "failed_txn"]
  .map((k) => APP_COLS.find((c) => c.key === k));

// ui = { query, sort: { key, dir } } (default: the server's order, most failed connections first).
export function appSitesView(data, ui, nowMs) {
  const all = data?.sites;
  const p = data?.progress;
  const out = {
    state: all == null ? (data?.status === "error" || (!data && ui.error) ? "error" : "loading") : "table",
    error: data?.error || ui.error || "",
    loadingText: `Querying this app at every site… ${p?.total ? `(${p.done} of ${p.total} batches of 10 sites)` : "(one query per 10 sites)"}`,
    age: data?.end_time ? { text: `updated ${ageText(nowMs - Date.parse(data.end_time))}${data.status === "running" ? " · refreshing…" : ""}`,
      tip: `24 h ending ${minuteLabel(data.end_time)}` } : null,
    cols: APP_SITES_COLS,
  };
  if (all == null) return out;
  const q = ui.query.trim().toLowerCase();
  let rows = q ? all.filter((s) => s.name.toLowerCase().includes(q)) : [...all];
  const col = APP_SITES_COLS.find((c) => c.key === ui.sort?.key);
  if (ui.sort?.key === "name") rows.sort((a, b) => a.name.localeCompare(b.name) * (ui.sort.dir === "asc" ? 1 : -1));
  else if (col) rows.sort((a, b) => (col.value(a) - col.value(b)) * (ui.sort.dir === "asc" ? 1 : -1) || a.name.localeCompare(b.name));
  const failing = all.filter((s) => s.failed_connections > 0);
  const sum = (k) => all.reduce((n, s) => n + (s[k] || 0), 0);
  const tcp = sum("tcp_flows"), failed = sum("failed_connections");
  return { ...out,
    summary: `${failing.length} of ${all.length} sites with this app's traffic had failed connections · ${failed.toLocaleString()} failed of `
      + `${tcp.toLocaleString()} TCP flows${tcp ? ` (${pctTxt(failed / tcp * 100)})` : ""} · ${data.site_count} sites queried`,
    rows: rows.map((s) => ({ id: s.id, name: s.name, site: s, anyFailed: s.failed_connections > 0,
      cells: Object.fromEntries(APP_SITES_COLS.map((c) => [c.key, c.cell(s)])) })),
    empty: rows.length ? null : q ? `No sites match “${ui.query.trim()}”.` : "No traffic for this app at the Overview's sites in the last 24 h.",
  };
}
