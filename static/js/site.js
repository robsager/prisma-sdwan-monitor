// Site details: loading a site, its live updates and the period, mixed into the page component.
// Only the open site polls; returning to it within SITE_REUSE_MS shows what was loaded at once.

import { api, poller, prefs, tenantPath } from "./api.js";
import { STATUS_ICON, THRESHOLDS } from "./overview-model.js";
import { PROBES_POLL_MS, probesView } from "./probes-model.js";
import { flowsUrl } from "./flows-model.js";
import { DEVICE_THRESHOLDS, activeAlarms, clearedAlarms, deviceRow, groupsText } from "./site-health-model.js";
import {
  LIVE, SITE_WINDOWS, circuitRow, metricErrors, newestMinute, nextPoll, siteLiveTag, siteTiles, statusText,
} from "./site-model.js";

const SITE_REUSE_MS = 10 * 60 * 1000;
const HEALTH_POLL_MS = 120000;   // device health (the server caches it 2 minutes)
const ALARMS_POLL_MS = 60000;    // active alarms (as fresh as the Overview's) and cleared ones (cached 2 minutes)

// Collapsible sections, remembered in this browser under 1.x's keys; the alarm sections and Probes
// start collapsed, as in 1.x (Probes aren't fetched until opened).
const COLLAPSE = { activeAlarms: "sdwan.activeAlarmsCollapsed", cleared: "sdwan.historyCollapsed", probes: "sdwan.probesCollapsed" };
const savedCollapse = () => Object.fromEntries(Object.entries(COLLAPSE).map(([k, key]) => [k, prefs.get(key, "1") === "1"]));

const savedWindow = () => {
  const h = Number(prefs.get("sdwan.siteWindow"));
  return SITE_WINDOWS.includes(h) ? h : 24;
};
const idleLive = () => ({ mode: "idle", newest: null, waitingSince: null, error: "", offset: 0, at: null, offline: false });

export const siteDetails = () => ({
  SITE_WINDOWS, THRESHOLDS, LIVE, statusText,

  site: null,          // /detail response; live updates replace each circuit's metrics
  siteLoading: false,
  siteError: "",
  siteLoadedAt: 0,
  siteSeq: 0,
  siteWindow: savedWindow(),
  live: idleLive(),
  liveTimer: null,
  liveBusy: false,
  // Device health and alarms of the open site: { key: "<tsg>:<site>", data, error }
  health: { key: null, data: null, error: "" },
  siteAlarms: { key: null, data: null, error: "" },
  probes: { key: null, data: null, error: "" },
  probeOpen: new Set(),     // probes showing each path (every site)
  collapsed: savedCollapse(),
  hideAcked: prefs.get("sdwan.hideAcked") === "1",
  historyOpen: new Set(),   // cleared alarm rows showing their occurrences
  historyAll: false,
  DEVICE_THRESHOLDS, STATUS_ICON,

  // ---- Flow Search links -------------------------------------------------------------------------

  // This site's flows: the last hour, or with an app or IP filter the given period (minutes).
  flowsLink(opts = {}) { return flowsUrl({ site: this.route.siteId, ...opts }); },
  // The flows around a utilization peak: 5 minutes either side of its minute.
  peakFlowsLink(time) {
    const t = new Date(time).getTime();
    return this.flowsLink({ start: t - 5 * 60000, end: Math.min(t + 6 * 60000, Date.now()) });
  },

  // ---- derived ----------------------------------------------------------------------------------

  siteFor(id) { return this.site && this.site.tsg_id === this.tsg && this.site.site.id === id ? this.site : null; },
  get siteCtx() {
    return { nowMs: this.nowMs + this.live.offset, hours: this.site?.window_hours ?? this.siteWindow, liveError: this.live.error,
      hub: this.site?.site?.role === "HUB" };
  },
  get circuitRows() { const ctx = this.siteCtx; return (this.site?.circuits || []).map((c) => circuitRow(c, ctx)); },
  get siteTiles() { return siteTiles(this.site?.circuits || [], this.site?.devices || []); },
  get siteTag() { return siteLiveTag(this.site?.circuits || [], this.siteCtx, this.live.offline); },
  get siteMetricErrors() { return metricErrors(this.site?.circuits || []); },
  get catchingUp() { return !!(this.site?.saved_until && !this.live.at); },
  // The open site (from the route, so its device health and alarms can load alongside /detail).
  get siteKey() { return this.tsg && this.route.name === "site" ? `${this.tsg}:${this.route.siteId}` : null; },
  get healthCtx() {
    const a = this.siteAlarms.key === this.siteKey ? this.siteAlarms.data : null;
    return { nowMs: this.siteCtx.nowMs, devices: this.site?.devices || [], circuits: this.site?.circuits || [], linkNames: a?.link_names || {} };
  },
  get alarmsData() { return this.siteAlarms.key === this.siteKey ? this.siteAlarms.data : null; },
  get healthData() { return this.health.key === this.siteKey ? this.health.data : null; },
  get probesData() { return this.probes.key === this.siteKey ? this.probes.data : null; },
  get probesError() { return this.probes.key === this.siteKey ? this.probes.error : ""; },
  get probesView() { return probesView(this.probesData, { open: this.probeOpen, siteName: this.siteName(this.route.siteId), hours: this.siteCtx.hours }); },
  toggleProbe(id) {
    const open = new Set(this.probeOpen);
    if (open.has(id)) open.delete(id); else open.add(id);
    this.probeOpen = open;
  },
  get deviceRows() {
    const h = this.healthData?.devices || {};
    const active = this.alarmsData?.active || [];
    return (this.site?.devices || []).map((d) => deviceRow(d, h[d.id], active, this.siteCtx.nowMs));
  },
  get healthNotes() {
    const e = this.health.key === this.siteKey ? this.health : {};
    return [e.error && `Device health failed to load: ${e.error}`, e.data?.error].filter(Boolean);
  },
  // The controller's active alarms and this manager's app connection-failure alarms (apps.js).
  get activeView() { return activeAlarms([...(this.alarmsData?.active || []), ...this.appAlarms], this.healthCtx, this.hideAcked); },
  get clearedView() { return clearedAlarms(this.alarmsData?.cleared, this.healthCtx, { open: this.historyOpen, showAll: this.historyAll }); },
  get clearedCount() { const v = this.clearedView; return groupsText(v.count, v.groups); },
  toggleSection(name) {
    this.collapsed[name] = !this.collapsed[name];
    prefs.set(COLLAPSE[name], this.collapsed[name] ? "1" : "0");
    if (name === "probes") { if (this.collapsed.probes) this.probesPoll?.stop(); else this.startProbes(); }
  },
  setHideAcked(on) { this.hideAcked = on; prefs.set("sdwan.hideAcked", on ? "1" : "0"); },
  toggleHistory(key) {
    const open = new Set(this.historyOpen);
    if (open.has(key)) open.delete(key); else open.add(key);
    this.historyOpen = open;
  },
  copySerial(serial) {
    navigator.clipboard?.writeText(serial).then(() => this.toast(`Copied ${serial}`), () => this.toast("Couldn't copy", "error"));
  },
  vcls(v) { return v ? ["v", v.st && `v-${v.st}`, !v.live && "stale"] : []; },

  // ---- loading ----------------------------------------------------------------------------------

  async loadSite(siteId, { force = false } = {}) {
    if (!this.tsg) return;
    const tsg = this.tsg;
    const cached = this.siteFor(siteId);
    this.siteError = "";
    if (cached && !force && Date.now() - this.siteLoadedAt < SITE_REUSE_MS) {
      this.startLive();
      this.startParts();
      return;
    }
    const seq = ++this.siteSeq;
    this.stopLive();
    this.startParts(); // they don't wait for /detail (which can take ~10 s on a cold open)
    if (!cached) this.site = null;
    this.siteLoading = true;
    try {
      const d = await api("GET", tenantPath(tsg, `/sites/${encodeURIComponent(siteId)}/detail?window=${this.siteWindow}h`));
      if (seq !== this.siteSeq || tsg !== this.tsg) return;
      this.site = d;
      this.siteLoadedAt = Date.now();
      this.nowMs = Date.now();
      if (this.route.name === "site" && this.route.siteId === siteId) this.startLive();
    } catch (err) {
      if (seq === this.siteSeq) this.siteError = err.message;
    } finally {
      if (seq === this.siteSeq) this.siteLoading = false;
    }
  },

  setWindow(h) {
    if (h === this.siteWindow) return;
    this.siteWindow = h;
    prefs.set("sdwan.siteWindow", String(h));
    this.refreshLive(); // the next update carries this period's figures (no new data needed)
    this.refreshApps();  // Top applications are a list per period
  },

  // ---- live updates -----------------------------------------------------------------------------

  // Restarts only the minute updates: device health, alarms and Top applications keep polling.
  startLive() {
    clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.live = idleLive();
    this.refreshLive(); // 1-minute data right away, then as each minute arrives
  },

  // Device health, alarms, probes (while open) and Top applications of the open site: now, then
  // every HEALTH_POLL_MS / ALARMS_POLL_MS / PROBES_POLL_MS (Top applications: apps.js).
  startParts() {
    this.devHealthPoll ||= poller(() => this.refreshHealth(), HEALTH_POLL_MS);
    this.alarmsPoll ||= poller(() => this.refreshAlarms(), ALARMS_POLL_MS);
    this.devHealthPoll.now();
    this.alarmsPoll.now();
    if (!this.collapsed.probes) this.startProbes();
    this.startApps();
  },
  startProbes() {
    this.probesPoll ||= poller(() => this.refreshPart("probes", "/probes"), PROBES_POLL_MS);
    this.probesPoll.now();
  },

  stopLive() {
    clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.live = idleLive();
    this.devHealthPoll?.stop();
    this.alarmsPoll?.stop();
    this.probesPoll?.stop();
    this.stopApps();
  },

  // Tab visible again: catch up at once.
  resumeSite() {
    this.refreshLive();
    if (this.siteKey) {
      this.devHealthPoll?.now();
      this.alarmsPoll?.now();
      if (!this.collapsed.probes) this.probesPoll?.now();
      this.refreshApps();
    }
  },

  // ---- device health and alarms (each keeps its last data when a refresh fails) ----------------

  async refreshPart(target, path) {
    const key = this.siteKey;
    if (!key) return;
    try {
      const data = await api("GET", tenantPath(this.tsg, `/sites/${encodeURIComponent(this.route.siteId)}${path}`));
      if (this.siteKey !== key) return;
      if (this[target].key !== key) this[target] = { key, data: null, error: "" };
      Object.assign(this[target], { data, error: "" });
    } catch (err) {
      if (this.siteKey !== key) return;
      if (this[target].key !== key) this[target] = { key, data: null, error: "" };
      this[target].error = err.message;
    }
  },
  refreshHealth() { return this.refreshPart("health", "/device-health"); },
  refreshAlarms() {
    if (this.siteAlarms.key !== this.siteKey) { this.historyOpen = new Set(); this.historyAll = false; }
    return this.refreshPart("siteAlarms", "/alarms");
  },

  scheduleLive(ms, mode) {
    clearTimeout(this.liveTimer);
    this.live.mode = mode;
    this.liveTimer = setTimeout(() => this.refreshLive(), Math.max(1000, ms));
  },

  async refreshLive() {
    const d = this.site;
    clearTimeout(this.liveTimer);
    if (!d || this.route.name !== "site" || this.route.siteId !== d.site.id) return; // only while open
    if (d.site.role === "HUB") return; // no circuit data at a data center: nothing to update
    if (document.hidden) { this.live.mode = "idle"; return; } // resumed by visibilitychange
    if (this.liveBusy) { this.scheduleLive(1000, this.live.mode); return; }
    this.liveBusy = true;
    const hours = this.siteWindow;
    try {
      const resp = await api("GET", tenantPath(d.tsg_id, `/sites/${encodeURIComponent(d.site.id)}/live?window=${hours}h`));
      if (this.site !== d) return;
      this.live.offset = Date.parse(resp.generated_at) - Date.now();
      this.live.error = "";
      if (resp.window_hours !== this.siteWindow) { this.scheduleLive(500, this.live.mode); return; } // the period changed meanwhile
      for (const c of d.circuits) {
        const upd = resp.circuits[c.id];
        if (upd) { c.metrics = upd.metrics; c.errors = upd.errors; }
      }
      d.window_hours = resp.window_hours;
      this.live.at = resp.generated_at;
      this.live.offline = resp.offline;
      this.nowMs = Date.now();
      const next = nextPoll(this.live, newestMinute(d.circuits),
        { nowMs: Date.now(), serverNowMs: Date.now() + this.live.offset, offline: resp.offline });
      this.live.newest = next.newest;
      this.live.waitingSince = next.waitingSince;
      this.scheduleLive(next.delay, next.mode);
    } catch (err) {
      if (this.site !== d) return;
      this.live.error = err.message;
      this.scheduleLive(LIVE.ERROR_MS, "error");
    } finally {
      this.liveBusy = false;
    }
  },
});
