// The Overview's Map, free of the DOM: sites as nodes, the VPN links between them as edges (one per
// pair of sites, coloured by its worst tunnel), and a hub layout around the data centers.
//
// topo = the server's /topology response: { sites: [{id, name, role, admin_state, city, country}],
//   links: [{id, type, status, admin_up, ends: [{site_id, site, circuit}] x2, vpnlinks}] }.
// AIOps scores a VPN link under its active vpnlink's id, so a tunnel's health is the worst of its ids.

export const MAP_POLL_MS = 60000;   // the server fetches the topology at most once a minute
// Tunnel states, worst first. off: disabled by an admin, or on demand and not in use: shown faint
// and never worst (live: 49 of 117 VPN links disabled, most to a standby data center).
export const TUNNEL_STATES = ["down", "poor", "fair", "unknown", "up", "off"];
export const TUNNEL_LABEL = { down: "Down", poor: "Up, health poor", fair: "Up, health fair", unknown: "State unknown", up: "Up", off: "Off" };
const RANK = Object.fromEntries(TUNNEL_STATES.map((s, i) => [s, i]));
const SPACING = 22;     // between branches on the ring (their labels point outward, so this can be tight)
const MIN_RING = 280;
// Top-down: branches in rows of at most ROW_MAX along the bottom, data centers in a row at the top.
const ROW_MAX = 80;
const ROW_GAP = 190;      // between branch rows (room for their labels, which point down)
const HUB_GAP = 170;      // at least this far apart side by side
const GW_GAP = 130;       // Branch Gateways, likewise
export const MAP_LAYOUTS = { rows: "Top-down", ring: "Ring" };  // the first is the default

export function tunnelState(link, linkHealth) {
  if (link.admin_up === false) return "off";
  if (!link.status) return "unknown";
  if (link.status !== "up") return link.sub_type === "on-demand" ? "off" : "down";
  const cats = [link.id, ...(link.vpnlinks || [])].map((i) => linkHealth?.[i]);
  return cats.includes("poor") ? "poor" : cats.includes("fair") ? "fair" : "up";
}

// "Down", "Not established (init)", "Disabled", "On demand, not in use", ...
function tunnelLabel(link, state) {
  if (state === "off") return link.admin_up === false ? "Disabled" : "On demand, not in use";
  if (state === "down" && link.status !== "down") return `Not up (${link.status})`;
  return TUNNEL_LABEL[state];
}

const end = (e) => (e.circuit && e.circuit !== e.site ? `${e.site || "?"} (${e.circuit})` : e.site || "?");

// { nodes: [{id, name, hub, gw (Branch Gateway on), role, city, country, disabled, row}], edges: [{key, a, b, state, tunnels:
// [{id, state, text}], down, total}] }. rows: the Overview's rows (status and problems) by site id;
// a site the Overview leaves out (data centers, when hidden) has row null.
export function mapGraph(topo, rows, linkHealth) {
  const byId = new Map(rows.map((r) => [r.site.id, r]));
  const nodes = (topo?.sites || []).map((s) => ({
    id: s.id, name: s.name, hub: s.role === "HUB", gw: s.role !== "HUB" && !!s.branch_gateway, role: s.role, city: s.city, country: s.country,
    disabled: s.admin_state && s.admin_state !== "active", row: byId.get(s.id) || null,
  }));
  const known = new Set(nodes.map((n) => n.id));
  const pairs = new Map();
  for (const link of topo?.links || []) {
    const [x, y] = link.ends;
    if (!known.has(x.site_id) || !known.has(y.site_id) || x.site_id === y.site_id) continue;
    const [a, b] = [x.site_id, y.site_id].sort();
    const key = `${a}|${b}`;
    const edge = pairs.get(key) || pairs.set(key, { key, a, b, tunnels: [] }).get(key);
    const state = tunnelState(link, linkHealth);
    edge.tunnels.push({ id: link.id, state, text: `${end(x)} ↔ ${end(y)}`, label: tunnelLabel(link, state) });
  }
  const edges = [...pairs.values()].map((e) => {
    e.tunnels.sort((p, q) => RANK[p.state] - RANK[q.state] || p.text.localeCompare(q.text));
    const live = e.tunnels.filter((t) => t.state !== "off");
    return { ...e, state: (live[0] || e.tunnels[0]).state, down: e.tunnels.filter((t) => t.state === "down").length, total: e.tunnels.length };
  });
  return { nodes, edges };
}

// Positions {id: {x, y, angle}}, the drawing's bounds and bend(a, b): the control point of a line
// between two branches. Branches are grouped by the data centers they connect to, so a hub's
// tunnels fan out without crossing the others; branches with tunnels only to other branches follow,
// and sites without tunnels come last. Ring (mode "ring"): data centers in the middle, each toward
// the branches that use it most, branches round one ring. Top-down ("rows"): data centers in a row
// at the top, each above the branches that use it most, branches in rows along the bottom, and
// Branch Gateways in a row between the two, each above the branches it connects to.
export function mapLayout(graph, mode = "ring") {
  const { nodes, edges } = graph;
  const hubs = nodes.filter((n) => n.hub).sort((p, q) => p.name.localeCompare(q.name));
  const branches = nodes.filter((n) => !n.hub);
  const hubIndex = new Map(hubs.map((h, i) => [h.id, i]));
  const degree = new Map(nodes.map((n) => [n.id, new Map()]));
  for (const e of edges) {
    degree.get(e.a).set(e.b, e.total);
    degree.get(e.b).set(e.a, e.total);
  }
  const hubsOf = (n) => [...degree.get(n.id)].filter(([id]) => hubIndex.has(id))
    .sort((p, q) => q[1] - p[1] || hubIndex.get(p[0]) - hubIndex.get(q[0])).map(([id]) => hubIndex.get(id));
  const sortKey = new Map(branches.map((n) => {
    const hs = hubsOf(n);
    const group = hs.length ? 0 : degree.get(n.id).size ? 1 : 2;
    return [n.id, { group, primary: hs[0] ?? -1, set: [...hs].sort((p, q) => p - q).join(","), hs }];
  }));
  branches.sort((p, q) => {
    const a = sortKey.get(p.id), b = sortKey.get(q.id);
    return a.group - b.group || a.primary - b.primary || a.set.localeCompare(b.set) || p.name.localeCompare(q.name);
  });

  if (mode === "rows") return rowsLayout(hubs, branches, sortKey, degree);
  const pos = {};
  const n = branches.length;
  const r = Math.max(MIN_RING, (n * SPACING) / (2 * Math.PI));
  branches.forEach((b, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / Math.max(n, 1);
    pos[b.id] = { x: r * Math.cos(angle), y: r * Math.sin(angle), angle };
  });

  // Each hub toward the branches it connects to, those whose main hub it is counting most (evenly
  // spread when it has none).
  const want = hubs.map((h, i) => {
    let sx = 0, sy = 0;
    for (const b of branches) {
      const k = sortKey.get(b.id);
      const w = k.primary === i ? 3 : k.hs.includes(i) ? 1 : 0;
      sx += w * Math.cos(pos[b.id].angle);
      sy += w * Math.sin(pos[b.id].angle);
    }
    return { h, angle: Math.hypot(sx, sy) > 1e-6 ? Math.atan2(sy, sx) : -Math.PI / 2 + (2 * Math.PI * i) / hubs.length };
  });
  if (hubs.length === 1) pos[hubs[0].id] = { x: 0, y: 0, angle: 0 };
  else if (hubs.length) {
    const hr = Math.min(r * 0.5, Math.max(140, (hubs.length * 110) / (2 * Math.PI)));
    const gap = Math.min((2 * Math.PI) / hubs.length, 1.0);
    want.sort((p, q) => p.angle - q.angle);
    for (let i = 1; i < want.length; i++) want[i].angle = Math.max(want[i].angle, want[i - 1].angle + gap);
    for (const { h, angle } of want) pos[h.id] = { x: hr * Math.cos(angle), y: hr * Math.sin(angle), angle };
  }
  const pad = 150;  // room for the branch labels
  return { pos, bounds: { x: -r - pad, y: -r - pad, w: 2 * (r + pad), h: 2 * (r + pad) },
    bend: (a, b) => ({ x: (a.x + b.x) * 0.3, y: (a.y + b.y) * 0.3 }) };  // toward the middle, off the ring
}

// Spread xs (sorted) to at least gap apart, then shift them back so the row stays centred on where
// they wanted to be.
function spread(xs, gap) {
  const out = [...xs];
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  const shift = out.length ? (xs.reduce((s, x) => s + x, 0) - out.reduce((s, x) => s + x, 0)) / out.length : 0;
  return out.map((x) => x + shift);
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function rowsLayout(hubs, all, sortKey, degree) {
  const pos = {};
  const gws = all.filter((b) => b.gw);
  const branches = all.filter((b) => !b.gw);
  const n = branches.length;
  const rows = Math.max(1, Math.ceil(n / ROW_MAX));
  const perRow = Math.ceil(n / rows) || 1;
  const width = Math.max(600, perRow * SPACING, hubs.length * HUB_GAP);
  const step = width / perRow;
  // Down the page, so their labels read top to bottom.
  branches.forEach((b, i) => {
    const row = Math.floor(i / perRow), col = i % perRow;
    pos[b.id] = { x: (col + 0.5) * step, y: row * ROW_GAP, angle: Math.PI / 2 };
  });
  const top = -Math.max(gws.length ? 420 : 320, width * 0.3);
  // A gateway above the branches it connects to (placed after the hubs when it has none).
  const gwX = new Map(gws.map((g) => [g.id, mean([...degree.get(g.id).keys()].filter((id) => pos[id]).map((id) => pos[id].x))]));
  const want = hubs.map((h, i) => {
    let sx = 0, w = 0;
    for (const g of gws) {
      if (gwX.get(g.id) != null && degree.get(g.id).has(h.id)) { sx += 2 * gwX.get(g.id); w += 2; }
    }
    for (const b of branches) {
      const k = sortKey.get(b.id);
      const wt = k.primary === i ? 3 : k.hs.includes(i) ? 1 : 0;
      sx += wt * pos[b.id].x;
      w += wt;
    }
    return { h, x: w ? sx / w : ((i + 0.5) * width) / hubs.length };
  }).sort((p, q) => p.x - q.x);
  const hx = spread(want.map((x) => x.x), HUB_GAP);
  want.forEach(({ h }, i) => { pos[h.id] = { x: hx[i], y: top, angle: 0 }; });
  const gwWant = gws.map((g, i) => ({ g, x: gwX.get(g.id) ?? mean([...degree.get(g.id).keys()].filter((id) => pos[id]).map((id) => pos[id].x))
    ?? ((i + 0.5) * width) / gws.length })).sort((p, q) => p.x - q.x || p.g.name.localeCompare(q.g.name));
  const gx = spread(gwWant.map((x) => x.x), GW_GAP);
  gwWant.forEach(({ g }, i) => { pos[g.id] = { x: gx[i], y: top / 2, angle: 0 }; });
  const xsAll = Object.values(pos).map((p) => p.x);
  const minX = Math.min(0, ...xsAll) - 120, maxX = Math.max(width, ...xsAll) + 120;
  return { pos, bounds: { x: minX, y: top - 80, w: maxX - minX, h: (rows - 1) * ROW_GAP - top + 80 + 170 },
    bend: (a, b) => ({ x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 60 - Math.abs(a.x - b.x) * 0.15 }) };  // arches above the row
}

// Counts for the heading: { sites, tunnels, down, poor, fair }.
export function mapCounts(graph) {
  const all = graph.edges.flatMap((e) => e.tunnels);
  const n = (s) => all.filter((t) => t.state === s).length;
  return { sites: graph.nodes.length, tunnels: all.length, down: n("down"), poor: n("poor"), fair: n("fair") };
}

// The site pairs with a tunnel down or fair / poor, worst first, for the list under the map.
// A data center is named second.
export function mapProblems(graph) {
  const node = new Map(graph.nodes.map((s) => [s.id, s]));
  return graph.edges.filter((e) => ["down", "poor", "fair"].includes(e.state))
    .map((e) => {
      const [a, b] = node.get(e.a).hub && !node.get(e.b).hub ? [e.b, e.a] : [e.a, e.b];
      return { ...e, a, b, aName: node.get(a).name, bName: node.get(b).name, bad: e.tunnels.filter((t) => ["down", "poor", "fair"].includes(t.state)) };
    })
    .sort((p, q) => RANK[p.state] - RANK[q.state] || q.down - p.down || p.aName.localeCompare(q.aName));
}
