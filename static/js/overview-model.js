// Overview logic, free of the DOM: what's wrong at each site, its status, and the filtered list.

import { ageText, fmt, hm, minuteLabel } from "./format.js";

// [warning, critical] levels, for the Overview and Site details. Tune to your SLAs.
export const THRESHOLDS = { latency_ms: [150, 300], jitter_ms: [30, 50], loss_pct: [1, 5], util_pct: [70, 90] };
export const STATUS_LABEL = { good: "OK", warning: "Warning", critical: "Critical" };
export const STATUS_ICON = { good: "●", warning: "▲", critical: "✕" };
export const SEV_RANK = { critical: 0, warning: 1, info: 2, good: 3 };
// A site's traffic is "live" when its newest utilization minute is this recent.
export const LIVE_MAX_AGE_MS = 180000;

export function status(value, [warn, crit]) {
  if (value == null) return null;
  if (value >= crit) return "critical";
  if (value >= warn) return "warning";
  return "good";
}

// ---- alarms ------------------------------------------------------------------------------------

const ALARM_LABEL = {
  SITE_CONNECTIVITY_DOWN: "Site connectivity down",
  SITE_CONNECTIVITY_DEGRADED: "Site connectivity degraded",
  NETWORK_ANYNETLINK_DOWN: "Secure fabric link down",
  NETWORK_ANYNETLINK_DEGRADED: "Secure fabric link degraded",
  NETWORK_DIRECTINTERNET_DOWN: "Direct Internet down",
  PEERING_BGP_DOWN: "BGP peer down",
  DEVICESW_DISCONNECTED_FROM_CONTROLLER: "ION disconnected from controller",
  DEVICESW_ANALYTICS_DISCONNECTED_FROM_CONTROLLER: "ION analytics disconnected",
  DEVICESW_FLOWS_DISCONNECTED_FROM_CONTROLLER: "ION flow reporting disconnected",
  DEVICESW_SLSCONNECTION_DOWN: "Logging service connection down",
  DEVICEHW_INTERFACE_DOWN: "Interface down",
  DEVICEHW_POWER_LOST: "Power supply lost",
  DEVICEHW_POWER_MISSING: "Power supply missing",
  SITE_CIRCUIT_ABSENT_FOR_POLICY: "Circuit absent for policy",
  DEVICESW_DHCPSERVER_ERRORS: "DHCP server errors",
  DEVICESW_GENERAL_PROCESSSTOP: "Process stopped",
  APPLICATION_PROBE_DISABLED: "Application probe disabled",
  APP_CONNECTION_FAILURES_HIGH: "App connection failures", // raised by this manager (apps-model.js)
};
// Down interfaces are often unused ports: listed, but they don't change a site's status.
const INFO_ALARMS = new Set(["DEVICEHW_INTERFACE_DOWN"]);

export const alarmLabel = (code) => ALARM_LABEL[code]
  || String(code || "Alarm").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const alarmSev = (a) => (INFO_ALARMS.has(a.code) ? "info" : a.severity === "critical" ? "critical" : "warning");

// A summary alarm (site connectivity down / degraded) has no details of its own: the alarms rolled
// up under it say what is down. "Secure fabric link down ×3, Direct Internet down".
export function causesText(causes) {
  const n = {};
  for (const c of causes) n[c.code] = (n[c.code] || 0) + 1;
  return Object.entries(n).map(([code, k]) => `${alarmLabel(code)}${k > 1 ? ` ×${k}` : ""}`).join(", ");
}

// Active alarms the server couldn't tie to a site (e.g. a User-ID agent's): a count for the
// alarms tile, and what they are for its tooltip.
export function unplacedText(alarms) {
  return { count: alarms.length, title: causesText(alarms) };
}

// ---- traffic -----------------------------------------------------------------------------------

// Newest utilization minute at a site, and whether it was current when the server fetched it.
// Utilization is cached for 5 minutes, so it's judged against that fetch time, not now.
export function siteTraffic(site, utilizationAtMs) {
  const times = (site.circuits || []).flatMap((c) => [c.down?.latest_time, c.up?.latest_time])
    .filter(Boolean).map(Date.parse);
  if (!times.length) return { newest: null, live: false };
  const newest = Math.max(...times);
  return { newest, live: utilizationAtMs - newest <= LIVE_MAX_AGE_MS };
}

// The tag next to a site's name: Live, Not live · 12 min ago, or No data.
export function liveTag(site, utilizationAtMs, nowMs) {
  const { newest, live } = siteTraffic(site, utilizationAtMs);
  if (newest == null) {
    const devs = site.devices || [];
    const offline = devs.length && devs.every((d) => !d.connected);
    return { kind: "none", text: "No data", title: offline ? "All ION devices are offline, so there is no traffic data" : "" };
  }
  if (live) return { kind: "live", text: "Live", title: `Current traffic data: newest minute ${hm(newest)}, utilization refreshed every 5 minutes` };
  return { kind: "stale", text: `Not live · ${ageText(nowMs - newest)}`, title: "" };
}

// ---- problems and status -----------------------------------------------------------------------

// Everything wrong at a site, worst first: [{sev, text, alarm?}].
export function siteProblems(site, { utilizationAtMs, nowMs }) {
  const out = [];
  const add = (sev, text, extra = {}) => out.push({ sev, text, ...extra });

  const devs = site.devices || [];
  const down = devs.filter((d) => !d.connected);
  if (devs.length && down.length === devs.length) add("critical", `All ION devices offline (${devs.length})`);
  else for (const d of down) add("critical", `${d.name} disconnected`);

  // Active alarms, one line per alarm code with a count.
  const groups = {};
  for (const a of site.alarms || []) (groups[a.code] ||= []).push(a);
  for (const [code, list] of Object.entries(groups)) {
    const sev = list.some((a) => alarmSev(a) === "critical") ? "critical" : alarmSev(list[0]);
    const since = list.map((a) => a.time).sort()[0];
    const causes = causesText(list.flatMap((a) => a.causes || []));
    add(sev, `${alarmLabel(code)}${list.length > 1 ? ` ×${list.length}` : ""}${causes ? ` (${causes})` : ""} · since ${minuteLabel(since)}`,
      { alarm: true });
  }

  for (const c of site.circuits || []) {
    for (const dir of ["down", "up"]) {
      const st = c[dir] ? status(c[dir].latest_pct, THRESHOLDS.util_pct) : null;
      if (st === "warning" || st === "critical") {
        add(st, `${c.name}: ${dir === "down" ? "download" : "upload"} ${fmt(c[dir].latest_pct)}% of capacity`);
      }
    }
  }

  // No current traffic from any circuit (e.g. site offline), unless devices already explain it.
  const { newest, live } = siteTraffic(site, utilizationAtMs);
  if ((site.circuits || []).length && !down.length && !live) {
    add("warning", newest ? `No current traffic data · last ${ageText(nowMs - newest)}` : "No current traffic data");
  }
  return out.sort((x, y) => SEV_RANK[x.sev] - SEV_RANK[y.sev]);
}

export const siteStatus = (problems) => (problems.some((p) => p.sev === "critical") ? "critical"
  : problems.some((p) => p.sev === "warning") ? "warning" : "good");

export function siteRole(role) {
  return role === "HUB" ? "Data center" : role === "SPOKE" ? "Branch" : role;
}

// Overview rows: each site with its problems and status.
export function overviewRows(overview, nowMs) {
  const utilizationAtMs = Date.parse(overview.utilization_at) || nowMs;
  return overview.sites.map((site) => {
    const problems = siteProblems(site, { utilizationAtMs, nowMs });
    const devices = site.devices || [];
    return {
      site, problems, status: siteStatus(problems),
      online: devices.filter((d) => d.connected).length,
      tag: liveTag(site, utilizationAtMs, nowMs),
    };
  });
}

// The rows to show: matching the status chip and the search text, worst first.
// The Overview's site type filter: a data center is a HUB site, a Branch Gateway a branch with Branch Gateway on.
export const SITE_TYPES = [
  { key: "dc", label: "DC", title: "data center" },
  { key: "branch", label: "Branch", title: "branch" },
  { key: "gateway", label: "Branch Gateway", title: "Branch Gateway" },
];
export const siteType = (site) => (site.role === "HUB" ? "dc" : site.branch_gateway ? "gateway" : "branch");

// healthOf(siteId): the site's AIOps health (good | fair | poor | undefined), for the Health tile's filter.
export function visibleRows(rows, { status: wanted = "all", health = "all", type = "all", query = "" }, healthOf = () => null) {
  const q = query.trim().toLowerCase();
  return rows
    .filter((r) => wanted === "all" || r.status === wanted)
    .filter((r) => health === "all" || healthOf(r.site.id) === health)
    .filter((r) => type === "all" || siteType(r.site) === type)
    .filter((r) => !q || [r.site.name, r.site.city, r.site.country].some((v) => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => SEV_RANK[a.status] - SEV_RANK[b.status] || b.problems.length - a.problems.length
      || a.site.name.localeCompare(b.site.name));
}

export function statusCounts(rows) {
  const n = { critical: 0, warning: 0, good: 0 };
  for (const r of rows) n[r.status]++;
  return n;
}
