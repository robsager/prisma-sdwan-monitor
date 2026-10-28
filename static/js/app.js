// The page: tenants, routing, polling and the Overview, as one Alpine component (Site details are
// mixed in from site.js and apps.js, the Overview's Health tile and Tenant panel from panel.js, its
// Map view from map.js, the ION Connectivity Monitor from ion-monitor.js, the ION list from ion-list.js).

import { api, poller, prefs, tenantPath } from "./api.js";
import { hm, hms, plural } from "./format.js";
import { SITE_TYPES, STATUS_LABEL, overviewRows, siteRole, statusCounts, unplacedText, visibleRows } from "./overview-model.js";
import { topApps } from "./apps.js";
import { ionList } from "./ion-list.js";
import { ionMonitor } from "./ion-monitor.js";
import { topologyMap } from "./map.js";
import { tenantPanel } from "./panel.js";
import { siteDetails } from "./site.js";

const OVERVIEW_POLL_MS = 60000;   // the server rebuilds the Overview every 60 s while in use
const DEVICE_POLL_MS = 20000;     // ION status: one cheap tenant-wide call
const CLOCK_TICK_MS = 30000;      // refreshes "N min ago" texts
const PAGE = 60;                  // site cards / rows per "Show more"
const PROBLEMS_SHOWN = 6;
const TOAST_MS = 6000;
// The HELP dialog's topics, in the order its buttons show; each section's HELP button opens its own.
const HELP_TOPICS = [
  { key: "overview", label: "Overview" }, { key: "tenant", label: "Tenant health and apps" },
  { key: "site", label: "Circuits and devices" }, { key: "probes", label: "LQM and Probes" },
  { key: "apps", label: "Top applications" }, { key: "alarms", label: "Alarms" },
  { key: "ion", label: "ION Connectivity Monitor" }, { key: "updates", label: "How often things update" },
];

const parseRoute = () => {
  const m = location.hash.match(/^#\/site\/([^/?#]+)/);
  return m ? { name: "site", siteId: decodeURIComponent(m[1]) } : { name: "overview", siteId: null };
};

// Object spread would read getters once; copy them as getters.
const mixin = (...parts) => Object.defineProperties({}, Object.assign({}, ...parts.map(Object.getOwnPropertyDescriptors)));

const VIEWS = ["cards", "table", "map"];
const blankForm = () => ({ editing: false, tsg_id: "", name: "", client_id: "", client_secret: "", exclude_dc: true, msg: "", msgKind: "" });

document.addEventListener("alpine:init", () => {
  window.Alpine.data("manager", () => mixin(siteDetails(), topApps(), tenantPanel(), topologyMap(), ionMonitor(), ionList(), {
    // constants the template uses
    PAGE, PROBLEMS_SHOWN, DEVICE_POLL_MS, SITE_TYPES, STATUS_LABEL, HELP_TOPICS, hm, hms, plural, siteRole,

    version: "",
    ready: false,
    startupError: "",
    tenants: [],
    tsg: prefs.get("sdwan.tsg"),
    route: parseRoute(),

    overview: null,
    loading: false,
    loadError: "",
    loadSeq: 0,
    devices: { checkedAt: null, error: "" },
    nowMs: Date.now(),
    secNow: Date.now(),    // ticks every second (countdowns)
    ui: { query: "", status: "all", health: "all", type: "all", view: VIEWS.includes(prefs.get("sdwan.ovView")) ? prefs.get("sdwan.ovView") : "cards", limit: PAGE },

    form: blankForm(),
    testResults: {},
    toasts: [],
    helpTopic: "overview",

    async init() {
      this.overviewPoll = poller(() => this.refreshOverview(), OVERVIEW_POLL_MS);
      this.devicePoll = poller(() => this.refreshDevices(), DEVICE_POLL_MS);
      window.addEventListener("hashchange", () => {
        this.route = parseRoute();
        this.ui.query = "";
        if (this.route.name === "site") { this.stopPanel(); this.stopMap(); this.loadSite(this.route.siteId); }
        else { this.stopLive(); this.collapsePanel(); if (this.tsg) { this.startPanel(); this.followMap(); } }
        window.scrollTo(0, 0);
      });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) return;
        if (this.tsg) this.resumeIon();
        if (this.route.name === "site") this.resumeSite();
        else if (this.tsg) { this.startPanel(); this.followMap(); }
        if (!this.overview) return;
        this.overviewPoll.now();
        this.devicePoll.now();
      });
      window.Alpine.effect(() => this.updateTitle()); // follows the route, site names and unseen ION events
      setInterval(() => { this.nowMs = Date.now(); }, CLOCK_TICK_MS);
      setInterval(() => { this.secNow = Date.now(); }, 1000);
      api("GET", "/api/version").then((v) => { this.version = v.version; }).catch(() => {});
      try {
        await this.loadTenants();
        if (this.tsg) { this.loadOverview(); this.startIonMonitor(); }
        if (this.tsg && this.route.name === "site") this.loadSite(this.route.siteId);
        else if (this.tsg) { this.startPanel(); this.followMap(); }
      } catch (err) {
        this.startupError = err.message;
      }
      this.ready = true;
      // Flow Search's "ION Connectivity Monitor" tab links to /?ionlog#/: open it here, then drop the flag.
      if (new URLSearchParams(location.search).has("ionlog")) {
        history.replaceState(null, "", location.pathname + location.hash);
        if (this.tsg) this.$nextTick(() => this.openIonMonitor());
      }
    },

    // ---- derived Overview data ------------------------------------------------------------------

    get rows() { return this.overview ? overviewRows(this.overview, this.nowMs) : []; },
    get counts() { return statusCounts(this.rows); },
    get matching() { return visibleRows(this.rows, this.ui, (id) => this.tenantHealthData?.sites?.[id]); },
    get shown() { return this.matching.slice(0, this.ui.limit); },
    // The Site status tile's numbers filter the sites in every view; clicking the active one shows all again.
    get statusFilters() {
      const c = this.counts;
      return [
        { key: "critical", label: "critical", n: c.critical },
        { key: "warning", label: "warning", n: c.warning },
        { key: "good", label: "OK", n: c.good },
      ];
    },
    // Site status and the Health tile's site numbers are one filter (one at a time); the site type
    // buttons (All / DC / Branch / Branch Gateway) combine with either, in every view.
    filterStatus(key) { this.ui.status = this.ui.status === key ? "all" : key; this.ui.health = "all"; this.ui.limit = PAGE; },
    filterSiteHealth(cat) { this.ui.health = this.ui.health === cat ? "all" : cat; this.ui.status = "all"; this.ui.limit = PAGE; },
    filterType(key) { this.ui.type = key; this.ui.limit = PAGE; },
    // The active filters as words ("critical branch", "fair-health data center"), or "" for none.
    get filterText() {
      return [this.ui.status !== "all" && STATUS_LABEL[this.ui.status].toLowerCase(), this.ui.health !== "all" && `${this.ui.health}-health`,
        SITE_TYPES.find((t) => t.key === this.ui.type)?.title].filter(Boolean).join(" ");
    },
    showAllSites() { this.ui.status = "all"; this.ui.health = "all"; this.ui.type = "all"; this.ui.limit = PAGE; },
    get alarmCount() { return (this.overview?.sites || []).reduce((n, s) => n + s.alarms.length, 0); },
    get unplaced() { return unplacedText(this.overview?.unplaced_alarms || []); },
    get onDeletedSites() { return unplacedText(this.overview?.deleted_site_alarms || []); },
    get devicesOnline() {
      const all = (this.overview?.sites || []).flatMap((s) => s.devices);
      return { up: all.filter((d) => d.connected).length, total: all.length };
    },

    siteHref: (site) => `#/site/${encodeURIComponent(site.id)}`,
    siteName(id) { return this.siteFor(id)?.site.name || this.overview?.sites.find((s) => s.id === id)?.name || id; },
    go(href) { location.hash = href; },
    setView(view) { this.ui.view = view; prefs.set("sdwan.ovView", view); this.followMap(); },
    // The Map's topology is polled only while it's shown.
    followMap() {
      if (this.tsg && this.route.name === "overview" && this.ui.view === "map") this.startMap();
      else this.stopMap();
    },

    // ---- loading and polling --------------------------------------------------------------------

    stopPolling() { this.overviewPoll.stop(); this.devicePoll.stop(); },

    async loadOverview() {
      const seq = ++this.loadSeq;
      const tsg = this.tsg;
      this.stopPolling();
      if (this.overview?.tsg_id !== tsg) this.overview = null;
      this.loading = true;
      this.loadError = "";
      try {
        const ov = await api("GET", tenantPath(tsg, "/overview"));
        if (seq !== this.loadSeq) return; // tenant changed or a newer load started
        this.overview = ov;
        this.devices = { checkedAt: Date.parse(ov.generated_at), error: "" };
        this.overviewPoll.start();
        this.devicePoll.start();
      } catch (err) {
        if (seq === this.loadSeq) { this.overview = null; this.loadError = err.message; }
      } finally {
        if (seq === this.loadSeq) this.loading = false;
      }
    },

    async refreshOverview() {
      const seq = this.loadSeq;
      try {
        const ov = await api("GET", tenantPath(this.tsg, "/overview"));
        if (seq === this.loadSeq) { this.overview = ov; this.nowMs = Date.now(); }
      } catch { /* keep the last Overview; the next cycle retries */ }
    },

    async refreshDevices() {
      const seq = this.loadSeq;
      try {
        const resp = await api("GET", tenantPath(this.tsg, "/devices"));
        if (seq !== this.loadSeq) return;
        const open = this.site?.tsg_id === this.tsg ? this.site : null;
        if (open) {
          const fresh = resp.devices[open.site.id] || [];
          if (JSON.stringify(fresh) !== JSON.stringify(open.devices)) open.devices = fresh;
          open.devices_error = null;
        }
        if (!this.overview) return;
        for (const site of this.overview.sites) {
          const fresh = resp.devices[site.id] || [];
          if (JSON.stringify(fresh) !== JSON.stringify(site.devices)) site.devices = fresh;
        }
        this.devices = { checkedAt: Date.parse(resp.generated_at), error: "" };
      } catch (err) {
        if (seq === this.loadSeq) this.devices.error = err.message; // keep the last known status
      }
    },

    // ---- tenants --------------------------------------------------------------------------------

    async loadTenants() {
      this.tenants = await api("GET", "/api/tenants");
      if (!this.tenants.some((t) => t.tsg_id === this.tsg)) {
        this.tsg = this.tenants[0]?.tsg_id || null;
        prefs.set("sdwan.tsg", this.tsg);
      }
    },

    switchTenant() {
      prefs.set("sdwan.tsg", this.tsg);
      this.stopLive();
      this.site = null;
      if (this.route.name !== "overview") this.go("#/"); // site ids belong to a tenant
      this.ui.status = "all";
      this.ui.health = "all";
      this.ui.type = "all";
      this.ui.limit = PAGE;
      this.resetPanel();
      this.loadOverview();
      this.startIonMonitor();
      if (this.route.name === "overview") { this.startPanel(); this.followMap(); }
    },

    // HELP: opens at a topic (or switches to it while open), at the top.
    openHelp(topic) {
      this.helpTopic = topic;
      const d = this.$refs.helpDialog;
      if (!d.open) d.showModal();
      d.scrollTo(0, 0);
    },
    get helpTitle() { return HELP_TOPICS.find((t) => t.key === this.helpTopic)?.label || ""; },

    openTenants() {
      this.resetForm();
      this.$refs.tenantDialog.showModal();
    },

    resetForm() { this.form = blankForm(); },

    editTenant(t) {
      this.form = { ...blankForm(), editing: true, tsg_id: t.tsg_id, name: t.name, exclude_dc: t.exclude_dc !== false,
        msg: "Re-enter the client ID to save changes." };
      this.$nextTick(() => this.$refs.clientId.focus());
    },

    async saveTenant() {
      const f = this.form;
      const body = { tsg_id: f.tsg_id.trim(), name: f.name.trim(), client_id: f.client_id.trim(),
        client_secret: f.client_secret, exclude_dc: f.exclude_dc };
      const first = !this.tenants.length;
      f.msg = "Saving…";
      f.msgKind = "";
      try {
        await api("POST", "/api/tenants", body);
        this.tsg = body.tsg_id;
        prefs.set("sdwan.tsg", this.tsg);
        await this.loadTenants();
        this.form = { ...blankForm(), msg: "Saved.", msgKind: "ok" };
        if (first) this.$refs.tenantDialog.close();
        this.switchTenant();
      } catch (err) {
        f.msg = err.message;
        f.msgKind = "err";
      }
    },

    async deleteTenant(t) {
      if (!confirm(`Delete tenant "${t.name}" (${t.tsg_id}) and its stored credentials?`)) return;
      try {
        await api("DELETE", tenantPath(t.tsg_id));
      } catch (err) {
        this.toast(`Couldn't delete ${t.name}: ${err.message}`, "error");
        return;
      }
      const wasCurrent = t.tsg_id === this.tsg;
      await this.loadTenants();
      this.toast(`Deleted ${t.name}`);
      if (!this.tsg) { this.stopPolling(); this.stopPanel(); this.stopMap(); this.stopIonMonitor(); this.overview = null; }
      else if (wasCurrent) this.switchTenant();
    },

    async testTenant(t) {
      this.testResults[t.tsg_id] = { busy: true, cls: "muted", text: "Testing…" };
      try {
        const r = await api("POST", tenantPath(t.tsg_id, "/test"));
        this.testResults[t.tsg_id] = { cls: "st good", text: `✓ ${r.tenant_name || "OK"} · ${r.region}` };
      } catch (err) {
        this.testResults[t.tsg_id] = { cls: "st critical", text: `✕ ${err.message}`, title: err.message };
      }
    },

    // ---- toasts ---------------------------------------------------------------------------------

    // toast("Saved") or toast({ title, text, sub, kind, ms }); ms null stays until dismissed. Newest on top.
    toast(text, kind = "ok") {
      const t = typeof text === "string" ? { text, kind, ms: TOAST_MS } : { kind: "ok", ms: TOAST_MS, ...text };
      t.id = Math.random().toString(36).slice(2);
      this.toasts.unshift(t);
      if (t.ms) setTimeout(() => this.dismiss(t.id), t.ms);
    },
    dismiss(id) { this.toasts = this.toasts.filter((t) => t.id !== id); },
  }));
});
