// ION Connectivity Monitor, free of the DOM: merging the server's log, the alert filter, and the texts.
//
// An event (from /ion-monitor): { id, rev, at (the controller's time), seen_at, site_id, site, device_id,
//   device, serial, up, away?, down_ms?, down_at?, missed?, reboot?: {at, info} | {none} | {unknown},
//   controller_down_ms?, serial_watch?, unclaimed? }. Newest first.

import { hms, minuteLabel } from "./format.js";
import { durText, secondLabel } from "./site-health-model.js";

export const WAIT_S = 25;              // a request waits on the server for the next event or check, up to this
export const RETRY_MS = 5000;          // after a failed request
export const REBOOT_CHECK_MS = 20000;  // the server reads an ION's status this long after it's back
export const UP_TOAST_MS = 60000;      // "back online" pop-ups fade; "offline" ones stay until dismissed

// Merge a poll into the page's copy. Returns { events, fresh, rebooted }: fresh = new events (none on a
// full load, which is the baseline), rebooted = known events whose reboot check just found a reboot.
export function mergeLog(local, resp) {
  if (resp.full || !local) return { events: resp.events, fresh: [], rebooted: [] };
  const byId = new Map(local.map((e) => [e.id, e]));
  const fresh = [], rebooted = [];
  for (const ev of resp.events) {
    const before = byId.get(ev.id);
    if (!before) fresh.push(ev);
    else if (ev.reboot?.at && !before.reboot?.at) rebooted.push(ev);
    byId.set(ev.id, ev);
  }
  const events = [...byId.values()].sort((a, b) => (b.at === a.at ? b.id - a.id : b.at < a.at ? -1 : 1));
  return { events, fresh, rebooted };
}

// Alert filter: comma-separated words; an event matches when its site or ION name contains one.
export const filterTerms = (text) => (text || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
export function matches(site, device, terms) {
  if (!terms.length) return true;
  const hay = `${site || ""}\n${device || ""}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}
// Serial watch events always alert: they were asked for by serial number.
export const alerts = (ev, terms) => !!ev.serial_watch || matches(ev.site, ev.device, terms);

// "Matches 2 IONs at 1 site", from the Overview's sites ({ name, devices }).
export function filterSummary(sites, terms) {
  if (!terms.length) return "No filter: alerts for every ION.";
  let ions = 0;
  const hit = new Set();
  for (const s of sites) {
    for (const d of s.devices || []) if (matches(s.name, d.name, terms)) { ions++; hit.add(s.id); }
  }
  return ions ? `Matches ${ions} ION${ions === 1 ? "" : "s"} at ${hit.size} site${hit.size === 1 ? "" : "s"} on the Overview.`
    : "Matches no ION at the sites on the Overview.";
}

export function eventText(ev) {
  if (ev.up && ev.unclaimed && ev.down_ms == null) return "connected to the controller";
  if (ev.missed) {
    return ev.controller_down_ms != null ? `back online after ${durText(ev.controller_down_ms)} offline between checks`
      : "reconnected; the controller never showed it offline";
  }
  if (!ev.up) return "went offline";
  return `back online${ev.down_ms != null ? ` after ${durText(ev.down_ms)} offline` : ""}`;
}

// "rebooted 14:31 (Software upgrade)", "no reboot: …", "checking for a reboot…", or why it couldn't be checked.
export function rebootText(ev, nowMs) {
  if (!ev.up) return "";
  const r = ev.reboot;
  if (!r) return nowMs - Date.parse(ev.seen_at || ev.at) < 3 * REBOOT_CHECK_MS ? "checking for a reboot…" : "not checked";
  if (r.unknown) return "reboot unknown";
  return r.at ? `rebooted ${minuteLabel(r.at)}${r.info ? ` (${r.info})` : ""}` : "no reboot: lost its controller connection";
}

// The log table: { rows, hidden, empty } with the filter applied.
export function logView(events, terms, nowMs, today = new Date(nowMs)) {
  const shown = (events || []).filter((e) => alerts(e, terms));
  const rows = shown.map((ev) => ({
    key: ev.id,
    time: secondLabel(ev.at, today),
    timeTip: ev.seen_at && ev.seen_at !== ev.at ? `The controller's time. The Monitor saw it at ${hms(Date.parse(ev.seen_at))}.` : "The controller's time",
    device: ev.device, serial: ev.serial,
    site: ev.site, siteHref: ev.site_id ? `#/site/${encodeURIComponent(ev.site_id)}` : null,
    st: ev.up ? "good" : "critical", icon: ev.up ? "●" : "✕", text: eventText(ev),
    away: !!ev.away,
    reboot: rebootText(ev, nowMs), rebootWarn: !!ev.reboot?.at, rebootTip: ev.reboot?.unknown || "",
    controller: ev.controller_down_ms != null ? `controller: offline ${durText(ev.controller_down_ms)}` : "",
  }));
  return { rows, hidden: (events || []).length - shown.length };
}

// A pop-up for one event: { title, text, sub, kind, ms } (ms null: stays until dismissed).
export function eventToast(ev, note) {
  const text = note ? `back online: ${note}` : eventText(ev);
  return { title: ev.device, text, sub: `${ev.site} · ${hms(Date.parse(ev.at))}`, kind: ev.up ? "ok" : "error", ms: ev.up ? UP_TOAST_MS : null };
}
export const rebootNote = (ev) => `rebooted at ${hms(Date.parse(ev.reboot.at))}${ev.reboot.info ? ` (${ev.reboot.info})` : ""}`;

// The serial watch table rows.
export function serialRows(status) {
  return (status || []).map((m) => ({
    serial: m.serial,
    ion: m.name || (m.found ? `${m.model || ""}${m.state === "claimed" ? "" : ` (${m.state || "not claimed"})`}` : ""),
    site: m.site_id ? m.site || m.site_id : m.found ? (m.state === "claimed" ? "no site" : "not claimed") : "",
    siteHref: m.site_id ? `#/site/${encodeURIComponent(m.site_id)}` : null,
    st: !m.found ? null : m.connected ? "good" : "critical",
    text: !m.found ? "not in this tenant" : m.connected ? "connected" : "not connected",
  }));
}

export const parseSerials = (text) => [...new Set((text || "").split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];

// Falling tones for offline (twice), rising for back online.
export const SOUND_NOTES = { down: [880, 440, 0, 880, 440], up: [523, 784] };
