// Site details' Top applications: polling the open site's list, the buttons, the Details dialog and
// acknowledging app alarms, mixed into the page component (with site.js).
//
// The server builds each list in a background job: a "running" response carries the previous
// result if there is one, so this polls every APPS_FAST_MS until "complete", then when the
// server's copy expires (at most every TOP_APPS_POLL_MS). Not at a data center: apps aren't tracked
// there, so its section is hidden and nothing is asked for.

import { api, prefs, tenantPath } from "./api.js";
import {
  APPS_ERROR_MS, APPS_FAST_MS, TOP_APPS_POLL_MS, appDetailView, appRows, appsHeader, connAlarms, countdownText,
  nextSort, prefixView, pruneAcks, validSort,
} from "./apps-model.js";

const readJson = (key, fallback) => {
  try { return JSON.parse(prefs.get(key)) ?? fallback; } catch { return fallback; }
};

export const topApps = () => ({
  appsSnaps: {},       // "<tsg>:<site>:<hours>" -> the last /top-apps response
  appsNote: "",        // from the last button press ("try again in 40 s")
  appsTimer: null,
  appsBusy: false,
  appsNextAt: null,    // when the next automatic poll is due (the countdown)
  appsUi: { sort: validSort(readJson("sdwan.appSort2", null)), filter: "", showAll: false },
  connAcks: readJson("sdwan.connAcks", {}),
  // row: the app's counts at the site from the Overview's app sites (24 h), when opened from there.
  appDetail: { siteId: null, appId: null, name: "", hours: null, data: null, error: "", loading: false, prefixQuery: "", row: null },
  countdownText,

  // ---- derived ----------------------------------------------------------------------------------

  get appsKey() { return this.siteKey && `${this.siteKey}:${this.siteWindow}`; },
  get appsSnap() { return this.appsSnaps[this.appsKey] || null; },
  // The open site is a data center: known from /detail, the Overview, or the server's answer.
  get appsHub() {
    const id = this.route.siteId;
    if (!this.siteKey) return false;
    const role = this.siteFor(id)?.site.role ?? this.overview?.sites.find((s) => s.id === id)?.role;
    return role === "HUB" || this.appsSnaps[this.appsKey]?.status === "data_center";
  },
  get appsHead() { return appsHeader(this.appsSnap, { nowMs: this.secNow, nextPollAt: this.appsNextAt, note: this.appsNote }); },
  get appsView() { const u = this.appsUi; return appRows(this.appsSnap, { sort: u.sort, query: u.filter, showAll: u.showAll }); },
  get appAlarms() { return connAlarms(this.appsSnap, { tsg: this.tsg, siteId: this.route.siteId, acks: this.connAcks }); },
  sortMark(key) { return this.appsUi.sort.key === key ? (this.appsUi.sort.dir === "asc" ? " ▲" : " ▼") : ""; },
  ariaSort(key) { return this.appsUi.sort.key === key ? (this.appsUi.sort.dir === "asc" ? "ascending" : "descending") : "none"; },
  sortBy(key) {
    this.appsUi.sort = nextSort(this.appsUi.sort, key);
    prefs.set("sdwan.appSort2", JSON.stringify(this.appsUi.sort));
  },
  // A shortcut to one column, largest first (the Applications list's "Highest Conn fail %").
  sortDesc(key) {
    this.appsUi.sort = { key, dir: "desc" };
    prefs.set("sdwan.appSort2", JSON.stringify(this.appsUi.sort));
  },
  sortedDesc(key) { return this.appsUi.sort.key === key && this.appsUi.sort.dir === "desc"; },
  cellCls(c) { return [(c.v || c.st) && "v", c.st && `v-${c.st}`, c.muted && "muted", c.faded && "faded"]; },

  // ---- polling ----------------------------------------------------------------------------------

  startApps() {
    this.appsNote = "";
    this.appsUi.filter = "";
    this.appsUi.showAll = false;
    this.refreshApps();
  },
  stopApps() {
    clearTimeout(this.appsTimer);
    this.appsTimer = null;
    this.appsNextAt = null;
  },
  scheduleApps(ms) {
    clearTimeout(this.appsTimer);
    this.appsNextAt = Date.now() + ms;
    this.appsTimer = setTimeout(() => this.refreshApps(), ms);
  },

  async refreshApps() {
    const key = this.appsKey;
    clearTimeout(this.appsTimer);
    if (!key || document.hidden) return; // only while the site is open; resumed by visibilitychange
    if (this.appsHub) return;
    if (this.appsBusy) { this.scheduleApps(500); return; }
    this.appsBusy = true;
    let next = TOP_APPS_POLL_MS;
    try {
      const snap = await api("GET", tenantPath(this.tsg, `/sites/${encodeURIComponent(this.route.siteId)}/top-apps?window=${this.siteWindow}h`));
      if (this.appsKey !== key) { next = 500; return; } // the site or period changed meanwhile
      const prev = this.appsSnaps[key];
      // A failed first list after the server restarted: keep what this page already had.
      this.appsSnaps[key] = snap.apps == null && prev?.apps ? { ...prev, status: snap.status, error: snap.error } : snap;
      if (snap.status === "data_center") { next = null; return; }
      if (snap.status === "running") next = APPS_FAST_MS;
      else if (snap.status === "error") next = APPS_ERROR_MS;
      else if (snap.next_refresh_at) next = Math.min(TOP_APPS_POLL_MS, Math.max(5000, Date.parse(snap.next_refresh_at) - Date.now() + 2000));
      const acks = pruneAcks(this.connAcks, snap, { tsg: this.tsg, siteId: this.route.siteId });
      if (Object.keys(acks).length !== Object.keys(this.connAcks).length) this.saveAcks(acks);
    } catch (err) {
      if (this.appsKey !== key) { next = 500; return; }
      // Keep the last list on a failed poll; with none, say why.
      if (!this.appsSnaps[key]?.apps) this.appsSnaps[key] = { apps: null, status: "error", error: err.message, window_hours: this.siteWindow };
      next = APPS_ERROR_MS;
    } finally {
      this.appsBusy = false;
      if (this.appsKey && next != null) this.scheduleApps(next);
    }
  },

  // Load RTT / Load app unreachable / Refresh now: the server starts the job; poll it fast.
  async appsAction(kind) {
    const key = this.appsKey;
    if (!key) return;
    this.appsNote = "";
    try {
      const r = await api("POST", tenantPath(this.tsg, `/sites/${encodeURIComponent(this.route.siteId)}/top-apps/${kind}?window=${this.siteWindow}h`));
      if (r.status === "recent") this.appsNote = `Refreshed less than a minute ago; try again in ${r.retry_in_s} s.`;
      else if (r.status === "running" && this.appsSnaps[key]) this.appsSnaps[key] = { ...this.appsSnaps[key], status: "running" };
    } catch (err) {
      this.appsNote = `Couldn't start it: ${err.message}`;
    }
    this.scheduleApps(APPS_FAST_MS);
  },

  // ---- acknowledging app alarms (this browser only) ---------------------------------------------

  saveAcks(acks) {
    this.connAcks = acks;
    prefs.set("sdwan.connAcks", JSON.stringify(acks));
  },
  ackAlarm(key) { this.saveAcks({ ...this.connAcks, [key]: new Date().toISOString() }); },
  unackAlarm(key) {
    const acks = { ...this.connAcks };
    delete acks[key];
    this.saveAcks(acks);
  },

  // ---- Details dialog -----------------------------------------------------------------------------

  // The app's row in the list for the dialog's period (it fills in once that list is loaded).
  get detailApp() {
    const { siteId, appId, hours, name, row } = this.appDetail;
    const list = this.appsSnaps[`${this.tsg}:${siteId}:${hours}`]?.apps || [];
    return list.find((a) => a.id === appId) || (row && { ...row, id: appId, name }) || { id: appId, name };
  },
  get detailView() {
    const d = this.appDetail;
    return d.data ? appDetailView(d.data, this.detailApp, d.hours) : null;
  },
  get detailPrefixes() { return prefixView(this.appDetail.data, this.appDetail.prefixQuery); },
  get detailTitle() { return `${this.detailApp.name} · ${this.siteName(this.appDetail.siteId)} · last ${this.appDetail.hours} h`; },

  // From Top applications (the open site, its period) or from the Overview's app sites (any site, 24 h).
  // From the Overview the period is fixed at 24 h, the period of the counts it passes in (row).
  openAppDetail(appId, siteId = this.route.siteId, hours = this.siteWindow, name = null, row = null) {
    name ||= (this.appsSnap?.apps || []).find((a) => a.id === appId)?.name || appId;
    this.appDetail = { siteId, appId, name, hours, data: null, error: "", loading: true, prefixQuery: "", row };
    this.$refs.appDialog.showModal();
    this.loadAppDetail();
  },
  async loadAppDetail() {
    const d = this.appDetail;
    const want = `${d.siteId}:${d.appId}:${d.hours}`;
    const mine = () => `${this.appDetail.siteId}:${this.appDetail.appId}:${this.appDetail.hours}` === want;
    d.loading = true;
    d.error = "";
    try {
      const data = await api("GET", tenantPath(this.tsg, `/sites/${encodeURIComponent(d.siteId)}/apps/${encodeURIComponent(d.appId)}?window=${d.hours}h`));
      if (mine()) this.appDetail.data = data;
    } catch (err) {
      if (mine()) this.appDetail.error = err.message;
    } finally {
      if (mine()) this.appDetail.loading = false;
    }
  },
  // The dialog's period buttons set the site's period too (as in 1.x) on that site's page, then reload the dialog.
  setDetailWindow(h) {
    if (this.route.name === "site" && this.route.siteId === this.appDetail.siteId) this.setWindow(h);
    Object.assign(this.appDetail, { hours: h, data: null });
    this.loadAppDetail();
  },
});
