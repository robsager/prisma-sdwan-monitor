// Site details logic, free of the DOM: each circuit's cells, the tiles, liveness and when to poll.
//
// ctx = { nowMs: the server's clock now, hours: the period, liveError: the last live update's error }

import { ageText, fmt, hm, minuteLabel } from "./format.js";
import { STATUS_LABEL, THRESHOLDS, status } from "./overview-model.js";

export const SITE_WINDOWS = [1, 4, 12, 24];

// Live updates. A minute shows up shortly after it ends: after seeing minute T, wait until T + 2 min
// (+ GRACE_MS), then check every FAST_MS until it arrives; after GIVE_UP_MS without one, every SLOW_MS.
export const LIVE = {
  FAST_MS: 10000, GRACE_MS: 10000, GIVE_UP_MS: 180000, SLOW_MS: 60000, ERROR_MS: 30000,
  MAX_AGE_MS: 180000, // a value is live when its minute started this recently
};

const METRIC = {
  latency: { th: THRESHOLDS.latency_ms, unit: "ms", digits: 1, label: "Latency" },
  jitter: { th: THRESHOLDS.jitter_ms, unit: "ms", digits: 2, label: "Jitter" },
  loss: { th: THRESHOLDS.loss_pct, unit: "%", digits: 2, label: "Loss" },
};

export const volTxt = (gb) => (gb == null ? "—" : gb >= 1000 ? `${fmt(gb / 1000, 2)} TB` : `${fmt(gb, 1)} GB`);
const mbpsTxt = (x) => (x == null ? "—" : `${fmt(x, 2)} Mbps`);
const pctTxt = (x) => (x == null ? "" : ` (${fmt(x)}%)`);

export const metricAge = (m, ctx) => (m?.latest_time ? ctx.nowMs - Date.parse(m.latest_time) : null);

export function isLive(m, ctx) {
  const age = metricAge(m, ctx);
  return age != null && !isNaN(age) && !ctx.liveError && age <= LIVE.MAX_AGE_MS;
}

// One value: { text, st, live } or null when there is no data.
function value(m, text, st, ctx) {
  return m?.latest == null ? null : { text, st, live: isLive(m, ctx) };
}

// Hover lines for one metric: the latest minute, then the period's peak and average.
function tipLines(label, m, v, ctx) {
  if (m?.latest == null && ctx.hub) return [`${label}: none at a data center. Link quality is measured at the branch end of each tunnel: open a branch`];
  if (m?.latest == null) return [`${label}: no data in the last ${ctx.hours} h`];
  const notLive = isLive(m, ctx) ? "" : ` (not live · ${ageText(metricAge(m, ctx))})`;
  return [
    `${label}: ${v(m.latest)} at ${minuteLabel(m.latest_time)}${notLive}`,
    `    ${ctx.hours} h peak ${v(m.peak)} at ${minuteLabel(m.peak_time)} · avg ${v(m.avg)}`,
  ];
}

// The line under a latency or loss value: spike count and the period's peak. Yellow even under the
// warning threshold (it's a spike for this circuit), red when the peak reached critical.
function spikeLine(m, th, v, prefix = "") {
  const sp = m?.spikes;
  if (!sp?.count) return null;
  return { prefix, text: `${sp.count} spike${sp.count === 1 ? "" : "s"} · max ${v(m.peak)}`, time: minuteLabel(m.peak_time),
    st: status(m.peak, th) === "critical" ? "critical" : "warning" };
}

function spikeTip(m, label, v, ctx) {
  const sp = m?.spikes;
  if (!sp || sp.median == null) return [];
  if (!sp.count) return [`No ${label} spikes in ${ctx.hours} h`];
  const span = (e) => (e.start === e.end ? minuteLabel(e.start) : `${minuteLabel(e.start)}–${minuteLabel(e.end)}`);
  return [`${label[0].toUpperCase()}${label.slice(1)} spikes, ${ctx.hours} h, newest first:`,
    ...sp.events.map((e) => `    ${span(e)} · ${e.minutes} min · peak ${v(e.peak)} at ${minuteLabel(e.peak_time)}`),
    ...(sp.count > sp.events.length ? [`    … ${sp.count - sp.events.length} older`] : [])];
}

// Latency: one round-trip value per circuit (the API has no one-way latency), and its spikes.
export function latencyCell(c, ctx) {
  const m = c.metrics?.latency;
  const def = METRIC.latency;
  const v = (x) => `${fmt(x, def.digits)} ${def.unit}`;
  const ms = (x) => `${fmt(x, 0)} ms`;
  return {
    value: value(m, m?.latest == null ? "" : v(m.latest), status(m?.latest, def.th), ctx),
    spikes: [spikeLine(m, def.th, ms)].filter(Boolean),
    tip: [...tipLines(def.label, m, v, ctx), ...spikeTip(m, "latency", ms, ctx)].join("\n"),
  };
}

// Jitter or loss: download / upload in one cell, each coloured by its own threshold; loss has spikes.
export function pairCell(c, base, ctx) {
  const down = c.metrics?.[`${base}_down`], up = c.metrics?.[`${base}_up`];
  const def = METRIC[base];
  const v = (x) => `${fmt(x, def.digits)} ${def.unit}`;
  const one = (m) => value(m, m?.latest == null ? "" : fmt(m.latest, def.digits), status(m?.latest, def.th), ctx);
  const tip = [...tipLines(`${def.label} ↓ down`, down, v, ctx), ...tipLines(`${def.label} ↑ up`, up, v, ctx)];
  let spikes = [];
  if (base === "loss") {
    const pv = (x) => `${fmt(x, x < 1 ? 2 : 1)}%`;
    spikes = [spikeLine(down, def.th, pv, "↓ "), spikeLine(up, def.th, pv, "↑ ")].filter(Boolean);
    tip.push(...spikeTip(down, "download loss", pv, ctx), ...spikeTip(up, "upload loss", pv, ctx));
  }
  return { down: one(down), up: one(up), empty: down?.latest == null && up?.latest == null, unit: def.unit, spikes, tip: tip.join("\n") };
}

// Utilization for one direction: a bar filled to the latest %, a tall tick at the period's peak and
// a short notch under it at its p95; the three values below it. Without a configured capacity, Mbps
// only and no bar.
export function utilCell(c, dir, ctx) {
  const m = c.metrics?.[`bw_${dir}`];
  if (m?.latest == null) return { empty: true };
  const capacity = dir === "down" ? c.bw_down_mbps : c.bw_up_mbps;
  const h = `${ctx.hours} h`;
  const live = isLive(m, ctx);
  const notLive = live ? "" : ` (not live · ${ageText(metricAge(m, ctx))})`;
  const tip = [
    `${dir === "down" ? "↓ Download" : "↑ Upload"}: ${mbpsTxt(m.latest)}${pctTxt(m.latest_pct)} at ${minuteLabel(m.latest_time)}${notLive}`,
    `    ${h} peak ${mbpsTxt(m.peak)}${pctTxt(m.peak_pct)} at ${minuteLabel(m.peak_time)}`,
    `    ${h} p95 ${mbpsTxt(m.p95)}${pctTxt(m.p95_pct)} (95% of minutes at or below this; a level, so no time)`,
    `    ${h} avg ${mbpsTxt(m.avg)} · ${volTxt(m.volume_gb)} transferred`,
    `    Capacity ${capacity ? `${fmt(capacity, 0)} Mbps` : "not configured"}`,
  ].join("\n");
  const th = THRESHOLDS.util_pct;
  const st = status(m.latest_pct, th);
  const hist = (label, mbps, p, time) => (mbps == null ? null : {
    text: `${fmt(mbps, 1)} Mbps`, st: status(p, th), time: time || null,
    tip: label === "peak"
      ? `${h} peak: ${fmt(mbps, 1)} Mbps${p == null ? "" : ` (${fmt(p)}% of capacity)`} at ${minuteLabel(time)}`
      : `${h} p95: ${fmt(mbps, 1)} Mbps${p == null ? "" : ` (${fmt(p)}% of capacity)`} · 95% of minutes were at or below this (a level, not a single moment)`,
  });
  const bar = m.latest_pct == null ? null : {
    width: Math.min(100, Math.max(m.latest_pct > 0 ? 2 : 0, m.latest_pct)),
    st,
    peak: m.peak_pct != null && m.peak_pct > m.latest_pct ? Math.min(100, m.peak_pct) : null,
    p95: m.p95_pct != null ? Math.min(100, m.p95_pct) : null,
    pct: m.latest_pct,
  };
  return {
    empty: false, tip, bar, live,
    latest: { text: `${fmt(m.latest, 1)} Mbps`, st, live, tip: m.latest_pct == null ? "Latest" : `Latest · ${fmt(m.latest_pct)}% of capacity` },
    p95: hist("p95", m.p95, m.p95_pct), peak: hist("peak", m.peak, m.peak_pct, m.peak_time),
  };
}

export function capacityCell(c) {
  const v = (x) => (x ? fmt(x, 0) : "—");
  if (!c.bw_down_mbps && !c.bw_up_mbps) return null;
  return { down: v(c.bw_down_mbps), up: v(c.bw_up_mbps), tip: `Configured: ${v(c.bw_down_mbps)} Mbps down / ${v(c.bw_up_mbps)} Mbps up` };
}

// Under the circuit's name when none of its values is live.
export function staleNote(c, ctx) {
  const ms = Object.values(c.metrics || {});
  if (ms.some((m) => isLive(m, ctx))) return "";
  const ages = ms.map((m) => metricAge(m, ctx)).filter((a) => a != null && !isNaN(a));
  return ages.length ? `Not live · last data ${ageText(Math.min(...ages))}` : `No data in the last ${ctx.hours} h`;
}

export function circuitRow(c, ctx) {
  return {
    id: c.id, name: c.name, sub: [c.network, c.label].filter(Boolean).join(" · "), stale: staleNote(c, ctx),
    latency: latencyCell(c, ctx), jitter: pairCell(c, "jitter", ctx), loss: pairCell(c, "loss", ctx),
    capacity: capacityCell(c), down: utilCell(c, "down", ctx), up: utilCell(c, "up", ctx),
  };
}

// ---- the site ----------------------------------------------------------------------------------

// A circuit's statuses now: the latest values against the thresholds.
export function circuitIssues(c) {
  const m = c.metrics || {};
  return [
    status(m.latency?.latest, METRIC.latency.th),
    status(m.jitter_down?.latest, METRIC.jitter.th), status(m.jitter_up?.latest, METRIC.jitter.th),
    status(m.loss_down?.latest, METRIC.loss.th), status(m.loss_up?.latest, METRIC.loss.th),
    status(m.bw_down?.latest_pct, THRESHOLDS.util_pct), status(m.bw_up?.latest_pct, THRESHOLDS.util_pct),
  ];
}

export function worst(statuses) {
  return ["critical", "warning", "good"].find((s) => statuses.includes(s)) || null;
}

export function siteTiles(circuits, devices) {
  let issues = 0, critical = 0;
  for (const c of circuits) {
    const w = worst(circuitIssues(c));
    if (w === "warning" || w === "critical") issues++;
    if (w === "critical") critical++;
  }
  const sum = (k) => {
    const vals = circuits.map((c) => c.metrics?.[`bw_${k}`]?.volume_gb).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const up = devices.filter((d) => d.connected).length;
  return { devicesUp: up, devices: devices.length, disconnected: devices.length - up, issues, critical,
    volDown: volTxt(sum("down")), volUp: volTxt(sum("up")) };
}

// The tag next to the site's name: Live when any circuit has a current minute.
export function siteLiveTag(circuits, ctx, offline = false) {
  const ms = circuits.flatMap((c) => Object.values(c.metrics || {}));
  if (ms.some((m) => isLive(m, ctx))) {
    const newest = Math.max(...ms.map((m) => Date.parse(m.latest_time)).filter((t) => !isNaN(t)));
    return { kind: "live", text: "Live", title: `Live: newest minute ${hm(newest)}, refreshed automatically` };
  }
  if (!circuits.length) return null;
  const ages = ms.map((m) => metricAge(m, ctx)).filter((a) => a != null && !isNaN(a));
  const title = ctx.liveError ? `Live refresh failing: ${ctx.liveError}`
    : offline ? "Every ION at this site is offline; live updates resume when one reconnects"
      : "No recent data from this site (e.g. device offline)";
  return { kind: "stale", text: ages.length ? `Not live · last data ${ageText(Math.min(...ages))}` : "No data", title };
}

export function metricErrors(circuits) {
  return circuits.flatMap((c) => (c.errors || []).map((e) => `${c.name}: ${e}`));
}

// Newest minute (ms) across every metric of every circuit.
export function newestMinute(circuits) {
  let newest = null;
  for (const c of circuits) for (const m of Object.values(c.metrics || {})) {
    const t = Date.parse(m.latest_time);
    if (!isNaN(t) && (newest == null || t > newest)) newest = t;
  }
  return newest;
}

// When to ask for the next live update, after one that returned `newest` (ms, server time).
// state = { newest, waitingSince } from the previous call. Returns { delay, mode, newest, waitingSince }.
export function nextPoll(state, newest, { nowMs, serverNowMs, offline = false }) {
  if (offline) return { delay: LIVE.SLOW_MS, mode: "offline", newest: state.newest, waitingSince: null };
  if (newest != null && (state.newest == null || newest > state.newest)) {
    // A new minute: sleep until the following one can exist.
    const due = newest + 120000 + LIVE.GRACE_MS - serverNowMs;
    return { delay: Math.max(due, LIVE.FAST_MS), mode: due > LIVE.FAST_MS ? "sleeping" : "waiting", newest, waitingSince: null };
  }
  const waitingSince = state.waitingSince ?? nowMs;
  const quiet = newest == null || nowMs - waitingSince > LIVE.GIVE_UP_MS;
  return { delay: quiet ? LIVE.SLOW_MS : LIVE.FAST_MS, mode: quiet ? "backoff" : "waiting", newest: state.newest, waitingSince };
}

export const statusText = (st) => (st === "warning" || st === "critical" ? ` (${STATUS_LABEL[st].toLowerCase()})` : "");
