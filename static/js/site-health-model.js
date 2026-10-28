// Site details' Devices table and alarm sections, free of the DOM.
//
// ctx = { nowMs: the server's clock now, devices: the site's IONs, circuits: its circuits,
//         linkNames: {link id: name} from the alarms response }

import { APP_CONN_FAIL_ALARM_PCT } from "./apps-model.js";
import { ageText, fmt, minuteLabel } from "./format.js";
import { SEV_RANK, alarmLabel, alarmSev, status } from "./overview-model.js";

// ---- devices -----------------------------------------------------------------------------------

// [warning, critical]. The API reports free memory and disk; the table shows them as used.
export const DEVICE_THRESHOLDS = { cpu_pct: [80, 95], mem_used_pct: [85, 95], disk_used_pct: [85, 95] };
// A port going down is an interface alarm, not the device's hardware.
const NOT_HARDWARE = new Set(["DEVICEHW_INTERFACE_DOWN"]);

export function spanText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
export const durText = (ms) => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} s` : spanText(ms));

// Every active alarm with its rolled-up causes, flat.
const flat = (alarms) => alarms.flatMap((a) => [a, ...(a.causes || [])]);

// The device's active hardware alarms (power supplies etc.), causes included.
export function hardwareAlarms(active, deviceId) {
  return flat(active || []).filter((a) => a.element_id === deviceId && String(a.code).startsWith("DEVICEHW_") && !NOT_HARDWARE.has(a.code));
}

function pctCell(value, th, tip) {
  return value == null ? null : { text: `${fmt(value, 0)}%`, st: status(value, th), tip };
}

// HA: the role from the pair's status, else (not loaded yet, or failed) the configured priority.
export function haCell(device, ha) {
  if (device.ha_priority == null) return { kind: "standalone", text: "Standalone" };
  if (!ha?.state) return { kind: "configured", text: `HA, priority ${device.ha_priority}` };
  const peer = ha.peer_connected === false ? " It does not see its HA peer." : ha.peer_connected ? " It sees its HA peer." : "";
  return {
    kind: "live", active: ha.state === "active", noPeer: ha.peer_connected === false,
    text: ha.state.charAt(0).toUpperCase() + ha.state.slice(1),
    sub: `${ha.since ? `since ${minuteLabel(ha.since)} · ` : ""}priority ${ha.priority ?? device.ha_priority}`,
    tip: `Configured priority ${device.ha_priority}; effective now ${ha.priority ?? "unknown"}.${peer}`,
  };
}

export function deviceRow(device, health, active, nowMs) {
  const h = health || {};
  const at = h.metrics_time ? ` (5-minute average to ${minuteLabel(h.metrics_time)})` : "";
  const memUsed = h.memory_free_pct == null ? null : 100 - h.memory_free_pct;
  const diskUsed = h.disk_free_pct == null ? null : 100 - h.disk_free_pct;
  const temps = Object.entries(h.temps || {}).map(([k, v]) => `${k === "cpu" ? "CPU" : k} ${fmt(v, 0)} °C`);
  const hw = hardwareAlarms(active, device.id).map((a) => ({ st: alarmSev(a) === "critical" ? "critical" : "warning", text: alarmLabel(a.code) }));
  const since = device.connected ? h.connected_since : h.disconnected_at;
  const reboot = h.last_reboot ? `Last reboot ${minuteLabel(h.last_reboot)}${h.last_reboot_info ? `: ${h.last_reboot_info}` : ""}` : "";
  let uptime = null;
  if (h.last_reboot) {
    uptime = device.connected
      ? { text: `up ${spanText(nowMs - Date.parse(h.last_reboot))}`, muted: false, tip: reboot }
      : { text: `rebooted ${minuteLabel(h.last_reboot)}`, muted: true, tip: reboot };
  }
  return {
    id: device.id, name: device.name, connected: device.connected,
    conn: `${device.connected ? "Connected" : "Disconnected"}${since ? ` since ${minuteLabel(since)}` : ""}`,
    serial: device.serial || null, model: (device.model || "").toUpperCase() || null, software: device.software || null,
    ha: haCell(device, h.ha),
    cpu: pctCell(h.cpu_pct, DEVICE_THRESHOLDS.cpu_pct, `CPU ${fmt(h.cpu_pct, 1)}%${at}`),
    memory: pctCell(memUsed, DEVICE_THRESHOLDS.mem_used_pct, `Memory ${fmt(memUsed, 1)}% used (${fmt(h.memory_free_pct, 1)}% available)${at}`),
    disk: pctCell(diskUsed, DEVICE_THRESHOLDS.disk_used_pct, `Disk ${fmt(diskUsed, 1)}% used (${fmt(h.disk_free_pct, 1)}% available)${at}`),
    temps: temps.length ? temps.join(" · ") : null,
    hardware: hw, hardwareNone: !hw.length && device.connected,
    uptime,
  };
}

// ---- alarms ------------------------------------------------------------------------------------

const LINK_ENTITIES = new Set(["anynetlinks", "vpnlinks"]);
const ENTITY_LABEL = { waninterfaces: "Circuit", interfaces: "Interface", elements: "Device", sites: "Site",
  bgppeers: "BGP peer", anynetlinks: "Fabric link", vpnlinks: "VPN link" };

const deviceName = (ctx, id) => (ctx.devices || []).find((d) => d.id === id)?.name;

// "Fabric link: Verizon Fiber → DC-East (DC Transit)": the affected object, named from the site's data.
export function alarmEntity(a, ctx) {
  if (!a.entity_type || a.entity_type === "sites") return "";
  const name = a.entity_type === "waninterfaces" ? (ctx.circuits || []).find((c) => c.id === a.entity_id)?.name
    : a.entity_type === "elements" ? deviceName(ctx, a.entity_id)
      : LINK_ENTITIES.has(a.entity_type) ? ctx.linkNames?.[a.entity_id]
        : a.info?.name || a.info?.interface_name || a.info?.peer_name;
  return `${ENTITY_LABEL[a.entity_type] || a.entity_type}: ${name || a.entity_id}`;
}

// The alarm's own details: "reason: … · remote ip: …".
export const infoText = (info) => Object.entries(info || {})
  .filter(([, v]) => v != null && v !== "" && typeof v !== "object")
  .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ");

const sevOrder = (a, b) => SEV_RANK[alarmSev(a)] - SEV_RANK[alarmSev(b)] || String(b.time).localeCompare(String(a.time));

function alarmRow(a, ctx, cause) {
  if (a.generated) { // an app's connection failures (apps-model.js connAlarms): known only to this manager
    return {
      key: a.id, cause, sev: alarmSev(a), label: alarmLabel(a.code), generated: true,
      code: `Raised by this manager, not the controller: Conn fail over ${APP_CONN_FAIL_ALARM_PCT}%`,
      severity: a.severity, priority: "", device: "—", entity: `App: ${a.app}`, info: a.info_text,
      time: a.time || "", since: `Last ${a.window_hours} h`, sinceTip: `${a.window_hours} h ending ${minuteLabel(a.time)}`, age: "",
      acknowledged: a.acknowledged, ackKey: a.ack_key,
      ackTip: a.acknowledged ? `Acknowledged ${minuteLabel(a.acked_at)} in this browser`
        : `Acknowledge in this browser (not sent to the controller). Lasts until the ${a.window_hours} h rate drops to ${APP_CONN_FAIL_ALARM_PCT}% or below`,
    };
  }
  return {
    key: a.id, cause, sev: alarmSev(a), label: alarmLabel(a.code), code: a.code || "",
    severity: a.severity || "—", priority: a.priority || "",
    device: deviceName(ctx, a.element_id) || a.element_id || "—",
    entity: alarmEntity(a, ctx) || "—", info: infoText(a.info),
    time: a.time || "", since: minuteLabel(a.time), age: a.time ? ageText(ctx.nowMs - Date.parse(a.time)) : "",
    acknowledged: !!a.acknowledged,
  };
}

// The Active alarms table: worst first, newest first within a severity; each summary alarm followed
// by the alarms rolled up under it. hideAcked leaves acknowledged ones (and their causes) out.
export function activeAlarms(active, ctx, hideAcked = false) {
  const all = [...(active || [])].sort(sevOrder);
  const acked = all.filter((a) => a.acknowledged).length;
  const shown = hideAcked ? all.filter((a) => !a.acknowledged) : all;
  const rows = shown.flatMap((a) => [alarmRow(a, ctx, false),
    ...[...(a.causes || [])].sort((x, y) => alarmLabel(x.code).localeCompare(alarmLabel(y.code))).map((c) => alarmRow(c, ctx, true))]);
  return { total: all.length, acked, shown: shown.length, rows };
}

// ---- cleared alarms ----------------------------------------------------------------------------

export const HISTORY_SHOWN = 10;

// Times to the second (many fabric link alarms clear within seconds).
export function secondLabel(iso, today = new Date()) {
  const t = new Date(iso);
  if (isNaN(t)) return String(iso);
  const day = t.toDateString() === today.toDateString() ? "" : t.toLocaleDateString([], { month: "short", day: "numeric" }) + " ";
  return day + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const historyKey = (r) => [r.code, r.element_id, r.entity_type, r.entity_id].join("|");

function occurrence(o) {
  const until = o.cleared ? { text: secondLabel(o.cleared) }
    : o.updated ? { text: `by ${secondLabel(o.updated)}`, tip: `The controller didn't report when it cleared; its alarm record was last updated ${o.updated}` }
      : { text: "—" };
  const notes = [o.raised ? "" : "raised before the 24 h window", o.flaps ? `flapped ${o.flaps}×` : "",
    o.suppressed ? "rolled up under a site alarm" : ""].filter(Boolean).join(" · ");
  return {
    raised: o.raised ? secondLabel(o.raised) : "—", until, notes,
    duration: o.active_s == null ? "—" : `${o.cleared ? "" : "≤ "}${durText(o.active_s * 1000)}`,
  };
}

// The Cleared alarms table from the server's rows (one per alarm and affected object, newest
// first). open: Set of historyKey()s showing their occurrences; showAll: every row, else HISTORY_SHOWN
// (plus one, rather than a "Show all 11").
export function clearedAlarms(cleared, ctx, { open = new Set(), showAll = false } = {}) {
  const all = cleared?.rows || [];
  const cut = !showAll && all.length > HISTORY_SHOWN + 1;
  const rows = (cut ? all.slice(0, HISTORY_SHOWN) : all).map((r) => {
    const key = historyKey(r);
    const tip = (r.known < r.count ? `Total of the ${r.known} occurrences with known times` : "Total time active")
      + (r.flaps ? `; flapped ${r.flaps}× in all` : "");
    return {
      key, sev: alarmSev(r), label: alarmLabel(r.code), code: r.code || "",
      severity: r.severity || "—", priority: r.priority || "",
      device: deviceName(ctx, r.element_id) || r.element_id || "—", entity: alarmEntity(r, ctx) || "—",
      times: `${r.count}× · ${r.known ? durText(r.active_s * 1000) : "—"}`, timesTip: tip,
      last: r.last ? { text: `${r.last_bound ? "by " : ""}${minuteLabel(r.last)}`, age: ageText(ctx.nowMs - Date.parse(r.last)), iso: r.last } : null,
      open: open.has(key),
      occurrences: open.has(key) ? r.occurrences.map(occurrence) : [],
    };
  });
  return {
    count: cleared?.count ?? 0, groups: all.length, truncated: !!cleared?.truncated, rows,
    more: cut ? `Show all ${all.length}` : showAll && all.length > HISTORY_SHOWN + 1 ? "Show fewer" : null,
  };
}

export const groupsText = (n, groups) => (n ? `${n} in ${groups} row${groups === 1 ? "" : "s"}` : "0");
