// Site details' Probes section, free of the DOM.
//
// data = the server's /probes response: { hub, tunnels: [{ id, circuit, name, latency?: {avg, latest,
//   p95, max, max_time, as_of, stale}, quality?: {jitter_in, jitter_out, loss_in, loss_out, mos_in,
//   mos_out} }], probes: [{ id, name, protocol, target, extra_endpoints, slas: [{rule, limit}],
//   round_trips, paths: [{ circuit, kind: vpn | direct, name, path_id, minutes, by_hours?: {latest,
//   latest_time, avg, p95, max, max_time, jitter, minutes}, error?, tunnel?: {avg, ...as latency} }] }],
//   error }. latency, quality, by_hours and tunnel come per period of the selector: {"<h>": ...}.

import { fmt, minuteLabel, plural } from "./format.js";

export const PROBES_POLL_MS = 5 * 60 * 1000; // the server caches 5 minutes
// The delay past the data center is flagged at this many ms or more, when it's also more than the tunnel's.
export const BEYOND_DC_FLAG_MS = 50;

export const msText = (v) => (v == null ? "—" : `${fmt(v, v < 10 ? 1 : 0)} ms`);

// A VPN path's delay beyond the data center: the probe's average per round trip (HTTP ~2, HTTPS ~3)
// minus the tunnel's own latency (LQM). Link health and tunnel LQM can't see this part.
export function beyondDc(probe, path) {
  if (path.kind !== "vpn" || path.avg == null || !path.tunnel) return null;
  const perTrip = path.avg / (probe.round_trips || 1);
  const beyond = Math.max(0, perTrip - path.tunnel.avg);
  return { beyond, perTrip, flag: beyond >= BEYOND_DC_FLAG_MS && beyond > path.tunnel.avg };
}

function tunnelCells(probe, x) {
  if (x.kind !== "vpn") return { tunnel: { text: "—", muted: true, tip: "Direct internet: no tunnel" }, beyond: { text: "—", muted: true } };
  const u = beyondDc(probe, x);
  if (!u) return { tunnel: { text: "—", muted: true, tip: "No tunnel latency (LQM) for this path" }, beyond: { text: "—", muted: true } };
  const t = x.tunnel;
  const trips = probe.round_trips > 1
    ? `Probe ${fmt(x.avg, 0)} ms over about ${probe.round_trips} round trips (${probe.protocol}) = ${fmt(u.perTrip, 0)} ms each; ` : `Probe ${fmt(x.avg, 0)} ms; `;
  return {
    tunnel: { text: msText(t.avg), faded: t.stale, tip: t.stale ? `No LQM in this period; average of the hour ending ${minuteLabel(t.as_of)}` : "Average over the period" },
    beyond: { text: `${fmt(u.beyond, 0)} ms`, st: u.flag ? "warning" : null,
      tip: `${trips}tunnel ${fmt(t.avg, 0)} ms; so about ${fmt(u.beyond, 0)} ms is added past the data center ION (upstream of it)` },
  };
}

// Into the branch / out of it, as "0.9 / 0.6".
function inOut(q, key, digits) {
  const a = q?.[`${key}_in`], b = q?.[`${key}_out`];
  return a == null && b == null ? "—" : `${fmt(a, digits) ?? "—"} / ${fmt(b, digits) ?? "—"}`;
}

// The probes that run over each tunnel: tunnel id -> [{ name, text, st, tip }].
function tunnelProbes(list) {
  const out = {};
  for (const p of list) {
    const limits = p.slas.map((r) => r.limit).filter((v) => v != null);
    const limit = limits.length ? Math.min(...limits) : null;
    for (const x of p.paths) {
      if (x.kind !== "vpn") continue;
      const u = beyondDc(p, x);
      const over = x.avg != null && limit != null && x.avg > limit;
      const tip = x.error ? `${p.name}: probe query failed` : x.avg == null ? `${p.name}: no results in this period`
        : `${p.name} (${p.protocol}): avg ${msText(x.avg)}, p95 ${msText(x.p95)}${limit != null ? `, SLA ≤ ${limit} ms` : ""}`
          + (u ? `; about ${fmt(u.beyond, 0)} ms past the data center` : "");
      (out[x.path_id] ||= []).push({ name: p.name, text: `${p.name} ${x.avg == null ? "—" : msText(x.avg)}`,
        st: over ? "critical" : u?.flag ? "warning" : null, tip });
    }
  }
  return out;
}

// Each tunnel with its LQM over the hour and the probes over it. Avg and Max are shown; latest and p95
// are in Avg's tooltip (with one hour of data they add little: p95 of 12 five-minute values is ~ Max).
function tunnelRows(data) {
  const onTunnels = tunnelProbes(data.probes);
  const noProbe = data.probes.length ? "No probe runs over this tunnel: this site's probes are direct internet only"
    : "No probe runs over this tunnel: no probe profile on this site's circuits";
  return (data.tunnels || []).map((t) => {
    const l = t.latency, q = t.quality;
    const faded = !!l?.stale;
    const staleTip = faded ? `No LQM in this period; the hour ending ${minuteLabel(l.as_of)}` : "";
    return {
      id: t.id, circuit: t.circuit, name: `→ ${t.name}`, faded, none: !l && !q,
      avg: { text: msText(l?.avg), tip: [staleTip, l ? `Latest ${msText(l.latest)} at ${minuteLabel(l.as_of)} · p95 ${msText(l.p95)}` : ""].filter(Boolean).join(" · ") },
      max: { text: msText(l?.max), tip: staleTip || (l?.max_time ? `at ${minuteLabel(l.max_time)}` : "") },
      jitter: inOut(q, "jitter", 1), loss: inOut(q, "loss", 2), mos: inOut(q, "mos", 1),
      probes: onTunnels[t.id] || [], noProbe,
    };
  });
}

// The response with every figure of one period (hours) in place of the per-period ones.
function forPeriod(data, hours) {
  if (!data?.probes) return data;
  const h = String(hours), pick = (byHours) => byHours?.[h] ?? null;
  return {
    ...data,
    tunnels: (data.tunnels || []).map((t) => ({ ...t, latency: pick(t.latency), quality: pick(t.quality) })),
    probes: data.probes.map((p) => ({ ...p, paths: p.paths.map((x) => ({ ...x, ...(x.error ? {} : pick(x.by_hours) || { minutes: 0 }),
      tunnel: pick(x.tunnel) })) })),
  };
}

// The section: { count (heading text), empty (no probes), hub, tunnels: [tunnel rows], probes: [{ id,
// name, sub, sla, open, summary, rows }] }.
// open: probe ids showing their rows; siteName shortens circuit names in the summary
// ("branch1-inet1" at branch1 -> "inet1").
export function probesView(raw, { open = new Set(), siteName = "", hours = 1 } = {}) {
  const data = forPeriod(raw, hours);
  const list = data?.probes;
  if (!list) return null;
  const prefix = `${siteName}-`;
  const pathName = (x) => `${x.circuit.startsWith(prefix) ? x.circuit.slice(prefix.length) : x.circuit} ${x.kind === "vpn" ? `→ ${x.name}` : "direct"}`;
  const probes = list.map((p) => {
    const limits = p.slas.map((r) => r.limit).filter((v) => v != null);
    const limit = limits.length ? Math.min(...limits) : null;
    const cell = (v, tip = "") => ({ text: msText(v), st: v != null && limit != null && v > limit ? "critical" : null, tip });
    const maxAvg = Math.max(...p.paths.map((x) => x.avg || 0)) || 1;
    const measured = p.paths.filter((x) => x.avg != null).sort((a, b) => a.avg - b.avg);
    const upstream = p.paths.filter((x) => beyondDc(p, x)?.flag).length;
    const best = measured[0], worst = measured.length > 1 ? measured[measured.length - 1] : null;
    return {
      id: p.id, name: p.name, open: open.has(p.id),
      sub: `${p.protocol} ${p.target}${p.extra_endpoints ? ` +${p.extra_endpoints} more` : ""}`,
      sla: p.slas.length ? `SLA ${p.slas.map((r) => `${r.rule} ≤ ${r.limit} ms`).join(", ")}` : "",
      summary: {
        text: best ? `best ${msText(best.avg)} (${pathName(best)})${worst ? `, worst ${msText(worst.avg)} (${pathName(worst)})` : ""}` : "",
        upstream: upstream ? `${plural(upstream, "path")} slow beyond the data center` : "",
      },
      rows: p.paths.map((x) => ({
        key: `${x.circuit}|${x.kind}|${x.name}`, circuit: x.circuit, path: x.kind === "vpn" ? `→ ${x.name}` : x.name,
        error: x.error || "", none: !x.error && !x.minutes,
        avg: cell(x.avg, `Latest ${msText(x.latest)}${x.latest_time ? ` at ${minuteLabel(x.latest_time)}` : ""} · p95 ${msText(x.p95)}`),
        max: cell(x.max, x.max_time ? `at ${minuteLabel(x.max_time)}` : ""), jitter: { text: msText(x.jitter) },
        ...tunnelCells(p, x),
        bar: Math.max(2, ((x.avg || 0) / maxAvg) * 100),
        barTip: x.avg == null ? "" : x.avg >= maxAvg ? `${msText(x.avg)}: the slowest path` : `${msText(x.avg)}: ${fmt((x.avg / maxAvg) * 100, 0)}% of the slowest (${msText(maxAvg)})`,
      })),
    };
  });
  const tunnels = tunnelRows(data);
  return { count: data.hub ? "data center" : `${plural(tunnels.length, "tunnel")} · ${plural(list.length, "probe")}`,
    empty: !list.length && !data.hub, hub: !!data.hub, tunnels, probes, error: data.error || "" };
}
