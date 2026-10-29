// The Overview's Map view, mixed into the page component: polls /topology while the Map is shown
// and draws it as SVG (built here, not by Alpine: hundreds of nodes, and hover and zoom touch no
// reactive data). Click a site to open it; drag to pan, wheel or the buttons to zoom.

import { api, poller, prefs, tenantPath } from "./api.js";
import { STATUS_LABEL, siteRole, siteType } from "./overview-model.js";
import { MAP_LAYOUTS, MAP_POLL_MS, mapCounts, mapGraph, mapLayout, mapProblems } from "./map-model.js";

const SVG = "http://www.w3.org/2000/svg";
const TIP_TUNNELS = 8;
const MAP_PROBLEMS_SHOWN = 15;
const SHOW_OFF = "sdwan.mapShowOff";
const LAYOUT = "sdwan.mapLayout";
// Zoom and pan, kept across redraws (not reactive); reset for another tenant.
const view = { key: null, k: 1, x: 0, y: 0 };
let drawn = null;  // { svg, applyView } of the last drawing

const el = (tag, attrs = {}, parent = null) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export const topologyMap = () => ({
  MAP_PROBLEMS_SHOWN,
  topo: { key: null, data: null, error: "" },
  mapShowAll: false,
  mapShowOff: prefs.get(SHOW_OFF) === "1",
  MAP_LAYOUTS,
  mapLayoutMode: MAP_LAYOUTS[prefs.get(LAYOUT)] ? prefs.get(LAYOUT) : "rows",

  get mapGraph() {
    const topo = this.topo.key === this.tsg ? this.topo.data : null;
    return topo ? mapGraph(topo, this.rows, this.tenantHealthData?.links) : null;
  },
  get mapCounts() { return this.mapGraph ? mapCounts(this.mapGraph) : null; },
  get mapProblems() { return this.mapGraph ? mapProblems(this.mapGraph) : []; },

  // ---- polling ----------------------------------------------------------------------------------

  startMap() {
    this.mapPoll ||= poller(() => this.refreshTopology(), MAP_POLL_MS);
    this.mapPoll.now();
  },
  stopMap() { this.mapPoll?.stop(); },

  async refreshTopology() {
    const tsg = this.tsg;
    if (!tsg) return;
    try {
      const data = await api("GET", tenantPath(tsg, "/topology"));
      if (this.tsg === tsg) this.topo = { key: tsg, data, error: "" };
    } catch (err) {
      if (this.tsg !== tsg) return;
      if (this.topo.key !== tsg) this.topo = { key: tsg, data: null, error: "" };
      this.topo.error = err.message; // keep the last map on screen
    }
  },

  // ---- drawing ----------------------------------------------------------------------------------

  // Called from x-effect: redrawn when the topology, the sites' status, health or the filter change.
  drawMap(svg) {
    const graph = this.mapGraph;
    if (!svg || !graph || this.ui.view !== "map") return;
    const { status, health, type } = this.ui;
    const matched = status === "all" && health === "all" && type === "all" && !this.ui.query.trim() ? null : new Set(this.matching.map((r) => r.site.id));
    const q = this.ui.query.trim().toLowerCase();
    // Sites off the Overview (hidden data centers) have no status: kept unless the filter text or site type misses them.
    // A data center stays while one of the sites it connects to does.
    const offRow = (n) => (q && !n.name.toLowerCase().includes(q)) || (type !== "all" && siteType({ role: n.role, branch_gateway: n.gw }) !== type);
    const off = (n) => matched && !(matched.has(n.id) || (!n.row && !offRow(n)));
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const kept = new Set();
    for (const e of graph.edges) {
      if (!off(nodeById.get(e.a))) kept.add(e.b);
      if (!off(nodeById.get(e.b))) kept.add(e.a);
    }
    const dim = (n) => off(n) && !(n.hub && kept.has(n.id));
    const { pos, bounds, bend } = mapLayout(graph, this.mapLayoutMode);
    const key = `${this.tsg}|${this.mapLayoutMode}`;
    if (view.key !== key) Object.assign(view, { key, k: 1, x: 0, y: 0 });

    svg.replaceChildren();
    svg.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
    const root = el("g", { class: "map-root" }, svg);
    const edgeLayer = el("g", { class: "map-edges" }, root);
    const nodeLayer = el("g", { class: "map-nodes" }, root);
    const applyView = () => root.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
    applyView();

    const byNode = new Map(graph.nodes.map((n) => [n.id, { edges: [], nbrs: new Set() }]));
    const order = ["off", "up", "unknown", "fair", "poor", "down"];  // worst drawn last, on top
    // Lines whose every tunnel is off only on request (live: a third of a tenant's VPN links).
    const edges = graph.edges.filter((e) => this.mapShowOff || e.state !== "off").sort((p, q) => order.indexOf(p.state) - order.indexOf(q.state));
    for (const e of edges) {
      const a = pos[e.a], b = pos[e.b];
      const both = [e.a, e.b].some((id) => nodeById.get(id).hub || nodeById.get(id).gw);
      // Branch to branch bends (bend), so it doesn't run along the ring or the row.
      const c = both ? null : bend(a, b);
      const d = c ? `M${a.x} ${a.y}Q${c.x} ${c.y} ${b.x} ${b.y}` : `M${a.x} ${a.y}L${b.x} ${b.y}`;
      const faded = dim(nodeById.get(e.a)) && dim(nodeById.get(e.b));
      const g = el("g", { class: `edge e-${e.state}${faded ? " dim" : ""}` }, edgeLayer);
      el("path", { d, class: "line", "stroke-width": 1.4 + Math.min(e.total - 1, 4) * 0.6 }, g);
      el("path", { d, class: "hit" }, g);
      g.addEventListener("pointerenter", (ev) => { this.mapHover(svg, [e.a, e.b], [g]); this.mapTip(ev, this.edgeTip(e)); });
      g.addEventListener("pointermove", (ev) => this.mapTip(ev));
      g.addEventListener("pointerleave", () => { this.mapHover(svg); this.mapTip(null); });
      for (const id of [e.a, e.b]) byNode.get(id).edges.push(g);
      byNode.get(e.a).nbrs.add(e.b);
      byNode.get(e.b).nbrs.add(e.a);
    }

    for (const n of graph.nodes) {
      const p = pos[n.id];
      const st = n.row ? n.row.status : "none";
      const g = el("g", { class: `node n-${st}${n.hub ? " hub" : n.gw ? " gw" : ""}${n.disabled ? " disabled" : ""}${dim(n) ? " dim" : ""}`,
        transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: "link", "aria-label": `${n.name}, open site details`, "data-id": n.id }, nodeLayer);
      if (n.hub) el("rect", { x: -13, y: -13, width: 26, height: 26, rx: 5, class: "shape" }, g);
      else if (n.gw) el("path", { d: "M0 -11L11 0L0 11L-11 0Z", class: "shape" }, g);
      else el("circle", { r: 7, class: "shape" }, g);
      const label = el("text", { class: "label" }, g);
      label.textContent = n.name;
      // A data center's name on its outer side, away from the others.
      if (n.hub) Object.entries({ y: p.y < 0 ? -20 : 28, "text-anchor": "middle" }).forEach(([k, v]) => label.setAttribute(k, v));
      else if (n.gw && this.mapLayoutMode === "rows") Object.entries({ y: 25, "text-anchor": "middle" }).forEach(([k, v]) => label.setAttribute(k, v));
      else {
        // Pointing outward (down in Top-down), read left to right on both halves of the ring.
        const deg = (p.angle * 180) / Math.PI;
        const left = Math.cos(p.angle) < 0;
        label.setAttribute("transform", `rotate(${left ? deg + 180 : deg})`);
        label.setAttribute("x", left ? -12 : 12);
        label.setAttribute("text-anchor", left ? "end" : "start");
        label.setAttribute("dominant-baseline", "central");
      }
      const info = byNode.get(n.id);
      g.addEventListener("pointerenter", (ev) => { this.mapHover(svg, [n.id, ...info.nbrs], info.edges); this.mapTip(ev, this.nodeTip(n, graph)); });
      g.addEventListener("pointermove", (ev) => this.mapTip(ev));
      g.addEventListener("pointerleave", () => { this.mapHover(svg); this.mapTip(null); });
      g.addEventListener("click", () => { if (!svg.dataset.dragged) this.go(this.siteHref(n)); });
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); this.go(this.siteHref(n)); } });
    }

    drawn = { svg, applyView };
    this.bindMapControls(svg);
  },

  // Highlight a node or edge with its neighbors (ids) and edges; no args clears it.
  mapHover(svg, ids = null, edges = []) {
    svg.classList.toggle("hl", !!ids);
    for (const x of svg.querySelectorAll(".on")) x.classList.remove("on");
    if (!ids) return;
    for (const id of ids) svg.querySelector(`.node[data-id="${CSS.escape(id)}"]`)?.classList.add("on");
    for (const g of edges) g.classList.add("on");
  },

  // The tooltip: lines [{text, cls?}] at the pointer; lines omitted moves it; null hides it.
  mapTip(ev, lines) {
    const tip = this.$refs.mapTip;
    if (!tip) return;
    if (ev === null) { tip.hidden = true; return; }
    if (lines) {
      tip.replaceChildren(...lines.map(({ text, cls }) => Object.assign(document.createElement("div"), { textContent: text, className: cls || "" })));
      tip.hidden = false;
    }
    const box = tip.parentElement.getBoundingClientRect();
    const x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
    tip.style.left = `${Math.min(x, box.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${y + tip.offsetHeight > box.height ? y - tip.offsetHeight - 24 : y}px`;
  },

  nodeTip(n, graph) {
    const lines = [{ text: n.name, cls: "t-title" },
      { text: [n.hub ? "Data center" : n.gw ? "Branch Gateway" : siteRole(n.role), n.city, n.country, n.disabled ? "disabled" : ""].filter(Boolean).join(" · "), cls: "t-sub" }];
    if (n.row) lines.push({ text: `Status: ${STATUS_LABEL[n.row.status]}`, cls: `t-${n.row.status}` });
    for (const p of n.row?.problems.slice(0, 3) || []) lines.push({ text: `• ${p.text}`, cls: `t-${p.sev}` });
    const mine = graph.edges.filter((e) => e.a === n.id || e.b === n.id).flatMap((e) => e.tunnels);
    const down = mine.filter((t) => t.state === "down").length;
    lines.push({ text: mine.length ? `${mine.length} tunnel${mine.length === 1 ? "" : "s"}${down ? `, ${down} down` : ", none down"}` : "No VPN tunnels",
      cls: down ? "t-critical" : "" });
    lines.push({ text: "Click for site details", cls: "t-sub" });
    return lines;
  },

  edgeTip(e) {
    const lines = [{ text: `${e.total} tunnel${e.total === 1 ? "" : "s"}${e.down ? `, ${e.down} down` : ""}`, cls: "t-title" }];
    for (const t of e.tunnels.slice(0, TIP_TUNNELS)) lines.push({ text: `${t.text}: ${t.label}`, cls: `t-${t.state}` });
    if (e.tunnels.length > TIP_TUNNELS) lines.push({ text: `+${e.tunnels.length - TIP_TUNNELS} more`, cls: "t-sub" });
    return lines;
  },

  // ---- zoom and pan -----------------------------------------------------------------------------

  mapZoom(f, at = null) {
    const m = drawn;
    if (!m) return;
    const k = Math.min(8, Math.max(0.3, view.k * f));
    const vb = m.svg.viewBox.baseVal;
    const p = at || { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
    view.x = p.x - ((p.x - view.x) * k) / view.k;
    view.y = p.y - ((p.y - view.y) * k) / view.k;
    view.k = k;
    m.applyView();
  },
  setMapLayout(mode) {
    this.mapLayoutMode = mode;
    prefs.set(LAYOUT, mode);
  },
  toggleMapOff() {
    this.mapShowOff = !this.mapShowOff;
    prefs.set(SHOW_OFF, this.mapShowOff ? "1" : "0");
  },
  mapFit() {
    Object.assign(view, { k: 1, x: 0, y: 0 });
    drawn?.applyView();
  },

  bindMapControls(svg) {
    if (svg.dataset.bound) return;
    svg.dataset.bound = "1";
    const toSvg = (ev) => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(svg.getScreenCTM().inverse());
    svg.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      this.mapZoom(ev.deltaY < 0 ? 1.15 : 1 / 1.15, toSvg(ev));
    }, { passive: false });
    let drag = null;
    svg.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, scale: svg.getScreenCTM().a };
      delete svg.dataset.dragged;
    });
    svg.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!svg.dataset.dragged && Math.hypot(dx, dy) < 4) return;
      svg.dataset.dragged = "1";
      svg.classList.add("dragging");
      view.x = drag.vx + dx / drag.scale;
      view.y = drag.vy + dy / drag.scale;
      drawn.applyView();
    });
    const stop = () => {
      drag = null;
      svg.classList.remove("dragging");
      setTimeout(() => delete svg.dataset.dragged, 0); // after the click a drag ends with
    };
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointerleave", stop);
  },
});
