// The Overview's Health tile and Tenant panel: polling AIOps health and the tenant's applications,
// mixed into the page component. Only while the Overview is shown; the app list only while its
// section is expanded. Health issues and Applications open collapsed each time the Overview is
// shown; their expanded state isn't remembered. The server builds the app list in the background: a "running" response
// carries the last list if there is one, so this polls every TENANT_APPS_FAST_MS until it's done.

import { api, poller, prefs, tenantPath } from "./api.js";
import {
  APP_SITES_POLL_MS, HEALTH_POLL_MS, TENANT_APPS_FAST_MS, TENANT_APPS_POLL_MS, appSitesView, healthIssues, healthTile,
  siteHealthTag, tenantAppsView,
} from "./health-model.js";

// The keys that used to remember the sections' state, cleared so they don't linger.
for (const key of ["sdwan.tenantAppsCollapsed", "sdwan.healthIssuesCollapsed"]) prefs.set(key, null);

export const tenantPanel = () => ({
  tenantHealth: { key: null, data: null, error: "" },
  tenantApps: { key: null, data: null, error: "" },
  healthDetail: { key: null, data: null, error: "" },
  panelUi: { query: "", showAll: false, health: "all" },
  tenantAppsCollapsed: true,
  healthIssuesCollapsed: true,
  issuesFilter: null,   // { kind, cat }: Health issues shows only these (from the Health tile)
  tenantAppsTimer: null,
  tenantAppsBusy: false,
  healthDetailBusy: false,
  // Clicking an app: where it fails, per site (polled while the server builds it and the dialog is open).
  appSites: { tsg: null, appId: null, name: "", data: null, error: "", query: "", sort: { key: null, dir: "desc" } },
  appSitesTimer: null,

  // ---- derived ----------------------------------------------------------------------------------

  get tenantHealthData() { return this.tenantHealth.key === this.tsg ? this.tenantHealth.data : null; },
  get healthTile() { return healthTile(this.tenantHealth.key === this.tsg ? this.tenantHealth : null); },
  get healthIssues() {
    const busy = this.healthDetailBusy;
    const detail = this.healthIssuesCollapsed ? null : this.healthDetail.key === this.tsg ? { ...this.healthDetail, busy } : { data: null, error: "", busy };
    return healthIssues(this.tenantHealthData, Object.fromEntries((this.overview?.sites || []).map((s) => [s.id, s.name])), detail);
  },
  // Health issues' rows under the Health tile's filter.
  get issueRows() {
    const f = this.issuesFilter;
    const rows = this.healthIssues?.rows || [];
    return f ? rows.filter((r) => r.kind === f.kind && r.cat === f.cat) : rows;
  },
  siteHealth(id) { return siteHealthTag(this.tenantHealthData, id); },
  get tenantView() {
    const apps = this.tenantApps.key === this.tsg ? this.tenantApps : {};
    const ui = { ...this.panelUi, sort: this.appsUi.sort }; // sorted like Top applications, as in 1.x
    const v = tenantAppsView(apps.data, this.tenantHealthData, ui, this.nowMs);
    if (!apps.data && apps.error) return { ...v, state: "error", error: apps.error };
    return v;
  },
  get appSitesView() {
    const a = this.appSites;
    return appSitesView(a.tsg === this.tsg ? a.data : null, { query: a.query, sort: a.sort, error: a.error }, this.nowMs);
  },

  // ---- polling ----------------------------------------------------------------------------------

  startPanel() {
    this.healthPoll ||= poller(async () => { await this.refreshTenantHealth(); this.refreshHealthDetail(); }, HEALTH_POLL_MS);
    this.healthPoll.now();
    if (!this.tenantAppsCollapsed) this.refreshTenantApps();
  },
  stopPanel() {
    this.healthPoll?.stop();
    clearTimeout(this.tenantAppsTimer);
    this.tenantAppsTimer = null;
  },
  collapsePanel() {
    this.healthIssuesCollapsed = true;
    this.tenantAppsCollapsed = true;
    this.issuesFilter = null;
    this.panelUi.health = "all";
    clearTimeout(this.tenantAppsTimer);
    this.tenantAppsTimer = null;
  },
  resetPanel() {
    this.panelUi = { query: "", showAll: false, health: "all" };
    this.issuesFilter = null;
    this.$refs.appSitesDialog?.close();
  },

  // ---- the Health tile's numbers ----------------------------------------------------------------

  // Sites filter the site list; apps open Applications at that health; links open Health issues
  // with only those links (it lists fair and poor ones only, so Links good isn't a filter).
  // Clicking the active number again shows everything.
  healthActive(kind, cat) {
    if (kind === "sites") return this.ui.health === cat;
    if (kind === "apps") return !this.tenantAppsCollapsed && this.panelUi.health === cat;
    return !this.healthIssuesCollapsed && this.issuesFilter?.kind === kind && this.issuesFilter.cat === cat;
  },
  healthClickable: (kind, cat) => !(kind === "links" && cat === "good"),
  healthTitle(kind, cat) {
    if (!this.healthClickable(kind, cat)) return "Health issues lists only fair and poor links";
    if (this.healthActive(kind, cat)) return kind === "sites" ? "Show all sites" : `Show all ${kind === "apps" ? "apps" : "health issues"}`;
    return kind === "sites" ? `Show only sites in ${cat} health` : kind === "apps" ? `Show the ${cat} apps under Applications`
      : `Show the ${cat} links under Health issues`;
  },
  healthClick(kind, cat) {
    if (kind === "sites") return this.filterSiteHealth(cat);
    const off = this.healthActive(kind, cat);
    if (kind === "apps") {
      this.panelUi.health = off ? "all" : cat;
      this.panelUi.showAll = false;
      if (this.tenantAppsCollapsed) this.toggleTenantApps();
      this.$nextTick(() => this.$root.querySelector(".tenant-apps")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    } else {
      this.issuesFilter = off ? null : { kind, cat };
      if (this.healthIssuesCollapsed) this.toggleHealthIssues();
      this.$nextTick(() => this.$root.querySelector(".health-issues")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }
  },
  toggleHealthIssues() {
    this.healthIssuesCollapsed = !this.healthIssuesCollapsed;
    this.refreshHealthDetail();
  },
  toggleTenantApps() {
    this.tenantAppsCollapsed = !this.tenantAppsCollapsed;
    if (this.tenantAppsCollapsed) { clearTimeout(this.tenantAppsTimer); this.tenantAppsTimer = null; } else this.refreshTenantApps();
  },

  // ---- one app per site --------------------------------------------------------------------------

  openAppSites(appId, name) {
    this.appSites = { tsg: this.tsg, appId, name, data: null, error: "", query: "", sort: { key: null, dir: "desc" } };
    this.$refs.appSitesDialog.showModal();
    this.refreshAppSites();
  },
  closeAppSites() {
    clearTimeout(this.appSitesTimer);
    this.appSitesTimer = null;
    this.appSites.appId = null;
  },
  async refreshAppSites() {
    clearTimeout(this.appSitesTimer);
    const { tsg, appId } = this.appSites;
    if (!appId || tsg !== this.tsg) return;
    const mine = () => this.appSites.appId === appId && this.appSites.tsg === tsg && this.tsg === tsg;
    try {
      const data = await api("GET", tenantPath(tsg, `/apps/${encodeURIComponent(appId)}/sites`));
      if (!mine()) return;
      Object.assign(this.appSites, { data, error: "" });
      if (data.status === "running") this.appSitesTimer = setTimeout(() => this.refreshAppSites(), APP_SITES_POLL_MS);
    } catch (err) {
      if (mine()) this.appSites.error = err.message;
    }
  },
  appSitesSortBy(key) {
    const s = this.appSites.sort;
    this.appSites.sort = s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" };
  },
  appSitesMark(key) { const s = this.appSites.sort; return s.key === key ? (s.dir === "asc" ? " ▲" : " ▼") : ""; },
  appSitesAria(key) { const s = this.appSites.sort; return s.key === key ? (s.dir === "asc" ? "ascending" : "descending") : "none"; },

  async refreshTenantHealth() {
    const tsg = this.tsg;
    if (!tsg) return;
    try {
      const data = await api("GET", tenantPath(tsg, "/health"));
      if (this.tsg === tsg) this.tenantHealth = { key: tsg, data, error: "" };
    } catch (err) {
      if (this.tsg !== tsg) return;
      if (this.tenantHealth.key !== tsg) this.tenantHealth = { key: tsg, data: null, error: "" };
      this.tenantHealth.error = err.message; // keep the last health on screen
    }
  },

  // Health issues' details (AIOps' 5-minute intervals, the estimated causes): only while its table is open.
  async refreshHealthDetail() {
    const tsg = this.tsg;
    if (!tsg || this.healthIssuesCollapsed || this.healthDetailBusy) return;
    this.healthDetailBusy = true;
    try {
      const data = await api("GET", tenantPath(tsg, "/health/detail"));
      if (this.tsg === tsg) this.healthDetail = { key: tsg, data, error: "" };
    } catch (err) {
      if (this.tsg === tsg) this.healthDetail = { key: tsg, data: this.healthDetail.key === tsg ? this.healthDetail.data : null, error: err.message };
    } finally {
      this.healthDetailBusy = false;
    }
  },

  async refreshTenantApps() {
    const tsg = this.tsg;
    clearTimeout(this.tenantAppsTimer);
    if (!tsg || this.tenantAppsCollapsed || this.route.name !== "overview" || document.hidden) return;
    if (this.tenantAppsBusy) { this.tenantAppsTimer = setTimeout(() => this.refreshTenantApps(), 500); return; }
    this.tenantAppsBusy = true;
    let next = TENANT_APPS_POLL_MS;
    try {
      const data = await api("GET", tenantPath(tsg, "/apps"));
      if (this.tsg !== tsg) return;
      this.tenantApps = { key: tsg, data, error: "" };
      if (data.status === "running") next = TENANT_APPS_FAST_MS;
      else if (data.status === "error") next = 60000;
    } catch (err) {
      if (this.tsg !== tsg) return;
      if (this.tenantApps.key !== tsg) this.tenantApps = { key: tsg, data: null, error: "" };
      this.tenantApps.error = err.message;
      next = 60000;
    } finally {
      this.tenantAppsBusy = false;
    }
    if (this.tsg === tsg && !this.tenantAppsCollapsed && this.route.name === "overview") {
      this.tenantAppsTimer = setTimeout(() => this.refreshTenantApps(), next);
    }
  },
});
