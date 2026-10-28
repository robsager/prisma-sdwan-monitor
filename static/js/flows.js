// Flow Search page: the search form, the search job (start, poll, stop, keep going), and the results
// table with its column groups, filters, sorting, widths, summaries, CSV and API query viewer.
//
// Flows are kept outside Alpine's reactive state (a search can hold 200,000): `store` holds them and
// `rev` (reactive) is bumped when they change; the name maps likewise live in `names`, with `namesRev`.
// Getters that go over every flow are memoized on what they depend on.

import { api, prefs, tenantPath } from "./api.js";
import * as M from "./flows-model.js";

const POLL_MS = 1000;
const NAME_RETRY_MS = [3000, 10000, 30000];  // name maps fail now and then; retried before giving up
const PATH_MAX_WIDTH = 200;                  // px: Path starts no wider (its tooltip has the full name)
const FILTER_LIST_MAX = 500;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const DIGIT_COLUMNS = new Set(["time", "source_port", "destination_port", "rtt", "srt", "udp_trt", "bytes_c2s", "bytes_s2c",
  "bytes_total", "packets_c2s", "packets_s2c", "packets_total"]);

const sameDeps = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
const newView = () => ({ sortField: "flow_start_time_ms", sortDirection: "desc", page: 1, ipFilter: "", ipFilterMode: "or", colFilters: {} });
const readJson = (key) => { try { return JSON.parse(prefs.get(key)); } catch { return null; } };

function saveFile(content, type, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}
function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Text widths measured with the table's own fonts on a canvas, so columns are as wide as their widest
// value over every loaded flow without rendering them (sorting and paging never resize a column).
const measure = document.createElement("canvas").getContext("2d");
const widthCache = new Map();
let bodyFont = null;
function textWidth(text, size, { mono = false, weight = 400 } = {}) {
  bodyFont ||= getComputedStyle(document.body).fontFamily;
  const font = `${weight} ${size}px ${mono ? MONO : bodyFont}`;
  const key = `${font}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (widthCache.size > 200000) widthCache.clear();
    measure.font = font;
    w = measure.measureText(text).width;
    widthCache.set(key, w);
  }
  return w;
}

document.addEventListener("alpine:init", () => {
  window.Alpine.data("flowSearch", () => {
    // Per search: site id -> {flows (frozen array), index: Map(flow key -> position), remeasure: [merged flows]}
    let store = {};
    // Frozen, so reading it through Alpine's proxy doesn't wrap it (and every map in it) in another.
    const NO_NAMES = Object.freeze({ apps: {}, paths: {}, network: {}, priority: {}, security: {}, probeSlas: {} });
    let names = NO_NAMES;
    const memo = { active: {}, filtered: {}, widths: { deps: null }, endReason: {}, summary: {} };

    return {
      M,
      version: "",
      tenants: [],
      tenantsLoaded: false,
      tsg: "",
      authError: "",

      // reference data
      sites: [],
      appList: [],
      sitesReady: false,
      appsLoading: false,
      namesRev: 0,
      notes: { apps: "", paths: "", policies: "" },  // why a name map is missing
      policiesLoading: false,

      // form
      selectedSites: [], siteSearch: "", siteMenu: false, siteMissing: false,
      selectedApps: [], appSearch: "", appMenu: false,
      startTime: "", endTime: "", rangeLength: 60,
      ipAddress: "", ipMode: "source", destPorts: "", protocol: "",
      perPage: Number(prefs.get("flows.perPage")) || 100,
      nowMs: Date.now(),

      // search
      searching: false, searchError: "", searched: null,  // searched: the request of the results shown
      jobId: null, jobTsg: null, stopping: false, paused: false, resuming: false,
      softCap: 200000, estimate: null, startedAt: 0, elapsed: 0,
      progress: { completed: [], total: 0, windowsDone: 0, windowsTotal: 0, windowsActive: 0 },
      siteMeta: {}, siteIds: [], siteNames: {},
      rev: 0,
      deepFilter: null,

      // table
      view: newView(),
      hidden: M.loadHidden(readJson("flows.hiddenColumns")),
      userWidths: readJson("flows.columnWidths") || {},
      resizing: null,
      colMenu: { open: false, x: 0, y: 0 },
      colFilter: { open: false, key: "", label: "", x: 0, y: 0, values: [], search: "", draft: {} },
      summary: { mode: null, data: null, search: "", sort: "bytes", open: {} },
      apiQueryText: "",

      async init() {
        this.setLast(60);
        setInterval(() => { this.nowMs = Date.now(); }, 30000);
        api("GET", "/api/version").then((v) => { this.version = v.version; }).catch(() => {});
        // Leaving or reloading the page stops a running search; keepalive lets the request finish.
        window.addEventListener("pagehide", () => {
          if (this.jobId) {
            fetch(this.flowsPath(`/search/${this.jobId}/stop`, this.jobTsg),
              { method: "POST", keepalive: true, headers: { "X-Requested-With": "sdwan-dashboard" } }).catch(() => {});
          }
        });
        try {
          this.tenants = await api("GET", "/api/tenants");
        } catch { this.tenants = []; }
        this.tenantsLoaded = true;
        const saved = prefs.get("sdwan.tsg");
        this.tsg = (this.tenants.find((t) => t.tsg_id === saved) || this.tenants[0] || {}).tsg_id || "";
        if (!this.tsg) return;
        // A deep link waits for the sites and apps (a second or two), not the policy names (slower:
        // they only label results and fill in when ready).
        const form = this.loadForm();
        this.loadNames();
        await form;
        this.applyDeepLink();
      },

      flowsPath(rest, tsg = this.tsg) { return tenantPath(tsg, `/flows${rest}`); },

      async switchTenant() {
        prefs.set("sdwan.tsg", this.tsg);
        if (this.jobId) this.stopSearch();
        Object.assign(this, { jobId: null, jobTsg: null, searching: false, stopping: false, paused: false, estimate: null,
          sites: [], appList: [], sitesReady: false, selectedSites: [], selectedApps: [], searched: null, searchError: "",
          authError: "", siteMeta: {}, siteIds: [] });
        store = {};
        names = NO_NAMES;
        this.notes = { apps: "", paths: "", policies: "" };
        this.rev++; this.namesRev++;
        await Promise.all([this.loadForm(), this.loadNames()]);
      },

      // ---- reference data -------------------------------------------------------------------------

      async loadForm() {
        const tsg = this.tsg;
        this.appsLoading = true;
        try {
          const [sites] = await Promise.all([api("GET", this.flowsPath("/sites", tsg)), this.loadApps(tsg)]);
          if (tsg !== this.tsg) return;
          this.sites = sites.sites;
          this.sitesReady = true;
        } catch (err) {
          if (tsg === this.tsg) this.authError = err.message;
        } finally {
          if (tsg === this.tsg) this.appsLoading = false;
        }
      },

      loadApps(tsg = this.tsg) {
        return this.retrying("/apps", tsg, (data) => {
          this.appList = Object.freeze(data.apps);
          this.setNames({ apps: Object.fromEntries(data.apps.map((a) => [a.id, a.name])) });
          this.notes.apps = "";
        }, (err) => { this.notes.apps = err; });
      },

      loadNames(tsg = this.tsg) {
        this.policiesLoading = true;
        return Promise.all([
          this.retrying("/paths", tsg, (data) => {
            this.setNames({ paths: data });
            this.notes.paths = "";
          }, (err) => { this.notes.paths = `${err} — showing path types instead of names.`; }),
          this.retrying("/policies", tsg, (data) => {
            this.setNames({ network: data.network || {}, priority: data.priority || {}, security: data.security || {},
              probeSlas: data.probe_slas || {} });
            this.notes.policies = "";
            this.policiesLoading = false;
          }, (err) => { this.notes.policies = `${err} — showing raw IDs instead.`; this.policiesLoading = false; }),
        ]);
      },

      // GET a name map for tenant tsg, retried in the background before onFail. A response for a tenant
      // no longer selected is dropped.
      async retrying(path, tsg, onOk, onFail) {
        for (let attempt = 0; ; attempt++) {
          if (tsg !== this.tsg) return;
          try {
            const data = await api("GET", this.flowsPath(path, tsg));
            if (tsg === this.tsg) onOk(data);
            return;
          } catch (err) {
            if (tsg !== this.tsg) return;
            if (attempt >= NAME_RETRY_MS.length || /sign|auth|401|403/i.test(err.message)) { onFail(err.message); return; }
          }
          await new Promise((r) => setTimeout(r, NAME_RETRY_MS[attempt]));
        }
      },

      setNames(patch) { names = Object.freeze({ ...names, ...patch }); this.namesRev++; },
      get namesNow() { return this.namesRev, names; },
      siteName(id) { return this.siteNames[id] || this.sites.find((s) => s.id === id)?.name || id; },
      appLabel(id) { return M.appName(this.namesNow, id); },

      // ---- form ------------------------------------------------------------------------------------

      get siteMatches() {
        const q = this.siteSearch.toLowerCase();
        return q ? this.sites.filter((s) => s.name.toLowerCase().includes(q)) : this.sites;
      },
      get appMatches() {
        const q = this.appSearch.toLowerCase();
        return (q ? this.appList.filter((a) => a.name.toLowerCase().includes(q)) : this.appList).slice(0, 100);
      },
      toggleIn(list, id) {
        const i = list.indexOf(id);
        if (i === -1) list.push(id); else list.splice(i, 1);
        if (this.selectedSites.length) this.siteMissing = false;
      },

      setRange(start, end) { this.startTime = M.localInput(start); this.endTime = M.localInput(end); },
      setLast(mins) { this.rangeLength = mins; const now = new Date(); this.setRange(new Date(now - mins * 60000), now); },
      // A start picked by hand keeps the last chosen length, without going past now (unless it's in the future).
      startPicked() {
        const start = new Date(this.startTime);
        if (isNaN(start)) return;
        const now = new Date(), end = new Date(start.getTime() + this.rangeLength * 60000);
        this.endTime = M.localInput(end > now && start < now ? now : end);
      },
      step(dir) { const r = M.stepRange(new Date(this.startTime), new Date(this.endTime), dir); if (r) this.setRange(...r); },
      get canStepBack() {
        const r = M.stepRange(new Date(this.startTime), new Date(this.endTime), -1, this.nowMs);
        return !!r && !M.tooOld(r[0], this.nowMs);
      },
      get startTooOld() { return M.tooOld(new Date(this.startTime), this.nowMs); },
      get oldestInput() { return M.localInput(new Date(this.nowMs - M.MAX_AGE_DAYS * 86400e3 + 60000)); },
      get canStepForward() { const end = new Date(this.endTime); return !isNaN(end) && end.getTime() < this.nowMs - 60000; },
      get rangeMinutes() { const ms = new Date(this.endTime) - new Date(this.startTime); return isNaN(ms) ? null : Math.round(ms / 60000); },
      isLast(mins) { return this.rangeMinutes === mins && M.endsNow(new Date(this.endTime), this.nowMs); },
      get rangeSummary() { return M.rangeSummary(new Date(this.startTime), new Date(this.endTime), this.nowMs); },
      get narrowed() { return !!this.selectedApps.length || !!this.ipAddress.trim(); },
      needsFilter(mins) { return mins > M.UNFILTERED_MAX_MIN && !this.narrowed; },
      get rangeNeedsFilter() { return this.needsFilter(this.rangeMinutes); },
      lastTitle(mins) { return this.needsFilter(mins) ? "Needs an application or IP address filter" : `The last ${M.durationText(mins)}, up to now`; },
      stepText(dir) {
        const len = this.rangeMinutes > 0 ? `${M.durationText(this.rangeMinutes)} ` : "";
        return dir < 0 ? `◀ ${len}earlier` : `${len}later ▶`;
      },
      get ipLabel() { return `${{ source: "Source", dest: "Destination", either: "Source or Destination" }[this.ipMode]} IP address (optional)`; },
      // The picked range differs from the one shown (or being searched).
      get rangeChanged() {
        const s = this.searched;
        if (!s) return false;
        const start = new Date(this.startTime), end = new Date(this.endTime);
        return !isNaN(start) && !isNaN(end) && (start.toISOString() !== s.start_time || end.toISOString() !== s.end_time);
      },
      get rangeChangedText() {
        const s = this.searched, text = M.rangeText(new Date(s.start_time), new Date(s.end_time));
        return this.searching ? `Still searching ${text}. Click Search the new range instead to switch.`
          : `Not searched yet. Results below are for ${text}. Click Search flows.`;
      },
      setPerPage() { prefs.set("flows.perPage", String(this.perPage)); this.view.page = 1; },

      applyDeepLink() {
        const link = M.readDeepLink(location.search, this.sites, this.appList);
        if (!link) return;
        this.selectedSites = link.sites;
        this.selectedApps = link.apps;
        if (link.last) this.setLast(link.last);
        if (link.start) this.startTime = M.localInput(link.start);
        if (link.end) this.endTime = M.localInput(link.end);
        if (link.ip) this.ipAddress = link.ip;
        if (link.ipMode) this.ipMode = link.ipMode;
        this.deepFilter = link.filter;
        history.replaceState(null, "", location.pathname); // not again on reload
        if (link.run && this.selectedSites.length) this.search();
      },

      // ---- the search job ----------------------------------------------------------------------------

      async search() {
        if (!this.selectedSites.length) { this.siteMissing = true; return; }
        const ports = M.parsePorts(this.destPorts);
        if (!ports) { this.searchError = "Destination ports must be numbers from 1 to 65535, separated by commas."; return; }
        if (this.rangeNeedsFilter) { this.searchError = "Searches over 4 hours need an application or IP address filter."; return; }
        if (this.startTooOld) { this.searchError = `Flow Search covers the last ${M.MAX_AGE_DAYS} days only: pick a start inside them.`; return; }
        const body = {
          site_ids: [...this.selectedSites], start_time: new Date(this.startTime).toISOString(), end_time: new Date(this.endTime).toISOString(),
          app_ids: [...this.selectedApps], ip_address: this.ipAddress.trim(), ip_mode: this.ipMode, dest_ports: ports,
          protocol: Number(this.protocol) || 0,
        };
        const tsg = this.tsg;
        Object.assign(this, { searching: true, searchError: "", paused: false, resuming: false, estimate: null, stopping: false });
        let job = null;
        try {
          job = await api("POST", this.flowsPath("/search", tsg), body);
          if (tsg !== this.tsg) { api("POST", this.flowsPath(`/search/${job.job_id}/stop`, tsg)).catch(() => {}); return; }
          this.softCap = job.soft_cap;
          this.searched = { ...body, page_size: job.page_size };
          this.siteIds = [...body.site_ids];
          this.siteNames = Object.fromEntries(this.siteIds.map((id) => [id, this.siteName(id)]));
          store = Object.fromEntries(this.siteIds.map((id) => [id, { flows: Object.freeze([]), index: new Map(), remeasure: [] }]));
          this.siteMeta = {};
          this.progress = { completed: [], total: job.total, windowsDone: 0, windowsTotal: 0, windowsActive: 0 };
          this.startedAt = Date.now(); this.elapsed = 0;
          this.view = newView();
          if (this.deepFilter) {  // from a ?filter= link: once
            this.view.colFilters = { [this.deepFilter]: ["No"] };
            this.setHidden({ [this.deepFilter]: false });
          }
          this.rev++;
          this.jobId = job.job_id;
          this.jobTsg = tsg;
          await this.poll(job.job_id, tsg);
        } catch (err) {
          if (tsg === this.tsg) this.searchError = err.message;
        } finally {
          this.deepFilter = null;
          if (tsg === this.tsg && (job === null || this.jobId === job.job_id)) {
            Object.assign(this, { searching: false, jobId: null, jobTsg: null, stopping: false, paused: false, estimate: null });
          }
        }
      },

      async poll(jobId, tsg) {
        let since = 0;
        const current = () => this.jobId === jobId;
        for (;;) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          if (!current()) return;  // replaced (tenant switch, new range)
          const data = await api("GET", this.flowsPath(`/search/${jobId}?since=${since}`, tsg));
          if (!current()) return;
          this.take(data.batches || []);
          since = data.next;
          this.siteMeta = data.site_meta || {};
          this.progress = { completed: data.completed_site_ids || [], total: data.total, windowsDone: data.windows_done || 0,
            windowsTotal: data.windows_total || 0, windowsActive: data.windows_active || 0 };
          this.elapsed = Date.now() - this.startedAt;
          this.paused = !!data.paused;
          if (!data.paused) this.resuming = false;
          this.estimate = data.estimate || null;
          if (data.done) return;
        }
      },

      // A poll's batches, appended per site in one go (one re-sort per poll). Updates (the same flow's
      // record from another hourly window) are merged into the flow already loaded.
      take(batches) {
        if (!batches.length) return;
        const bySite = {};
        for (const b of batches) {
          const s = (bySite[b.site_id] ||= { flows: [], updates: [] });
          s.flows.push(...b.flows);
          s.updates.push(...(b.updates || []));
        }
        for (const [siteId, b] of Object.entries(bySite)) {
          const entry = store[siteId];
          if (!entry) continue;
          const siteName = this.siteNames[siteId];
          const stamp = (f) => { f._site_id = siteId; f._site_name = siteName; return Object.freeze(f); };
          const flows = entry.flows.concat(b.flows.map(stamp));
          for (let i = entry.flows.length; i < flows.length; i++) entry.index.set(M.flowKey(flows[i]), i);
          for (const u of b.updates) {
            const i = entry.index.get(M.flowKey(u));
            if (i == null) continue;  // the server sends a flow before its updates
            flows[i] = stamp(M.mergeFlowRecords(flows[i], u));
            entry.remeasure.push(flows[i]);
          }
          entry.flows = Object.freeze(flows);
        }
        this.rev++;
      },

      async stopSearch() {
        if (!this.jobId) return;
        this.stopping = true;
        try { await api("POST", this.flowsPath(`/search/${this.jobId}/stop`, this.jobTsg)); } catch { /* the poll shows real problems */ }
      },
      async resumeSearch() {
        if (!this.jobId) return;
        this.resuming = true;
        try { await api("POST", this.flowsPath(`/search/${this.jobId}/resume`, this.jobTsg)); } catch { this.resuming = false; }
      },
      // The range was changed while a search runs: drop that search and start one for the new range.
      async searchNewRange() {
        if (this.jobId) api("POST", this.flowsPath(`/search/${this.jobId}/stop`, this.jobTsg)).catch(() => {});
        Object.assign(this, { jobId: null, jobTsg: null, searching: false, stopping: false, paused: false, estimate: null });
        await this.search();
      },

      get flowCount() { return this.rev, Object.values(store).reduce((n, s) => n + s.flows.length, 0); },
      siteFlowCount(id) { return this.rev, store[id]?.flows.length || 0; },
      get estimateText() { return M.estimateText(this.estimate); },
      get progressPercent() { return M.progressPercent(this.progress); },
      get progressText() { return M.progressText(this.progress, this.elapsed, this.paused, this.estimate); },
      get largeEstimate() { const e = this.estimate; return !!e && (e.flows > this.softCap || e.seconds > 600); },
      get cachedText() {
        let cached = 0, total = 0;
        for (const m of Object.values(this.siteMeta)) { cached += m.cached_windows || 0; total += m.windows || 0; }
        return cached ? `${cached} of ${total} hourly windows from cache` : "";
      },
      get siteErrors() { return Object.entries(this.siteMeta).filter(([, m]) => m.error).map(([id, m]) => ({ id, name: this.siteName(id), text: m.error })); },
      get siteWarnings() {
        return Object.entries(this.siteMeta).filter(([, m]) => !m.error && m.warning)
          .map(([id, m]) => ({ id, name: this.siteName(id), count: this.siteFlowCount(id), text: m.warning }));
      },

      // ---- the table ------------------------------------------------------------------------------------

      get activeFlows() {
        const arrays = [this.rev, ...Object.values(store).map((s) => s.flows)];
        if (sameDeps(memo.active.deps, arrays)) return memo.active.value;
        const lists = arrays.slice(1);
        const value = lists.length === 1 ? lists[0] : Object.freeze([].concat(...lists));
        memo.active = { deps: arrays, value };
        return value;
      },
      get visibleColumns() { return M.COLUMNS.filter((c) => !this.hidden[c.key]); },
      get visibleKeys() { return this.visibleColumns.map((c) => c.key); },

      get filteredFlows() {
        const v = this.view;
        const deps = [this.activeFlows, this.namesNow, v.sortField, v.sortDirection, v.ipFilter, v.ipFilterMode, v.colFilters, this.hidden];
        if (sameDeps(memo.filtered.deps, deps)) return memo.filtered.value;
        const n = this.namesNow;
        const value = Object.freeze(M.sortFlows(n, M.applyFilters(n, this.activeFlows, v, this.visibleKeys), v.sortField, v.sortDirection));
        memo.filtered = { deps, value };
        return value;
      },
      get pages() { return Math.ceil(this.filteredFlows.length / this.perPage) || 1; },
      get page() { return Math.min(Math.max(1, this.view.page), this.pages); },
      get firstRow() { return (this.page - 1) * this.perPage; },
      get pageFlows() { return Object.freeze(this.filteredFlows.slice(this.firstRow, this.firstRow + this.perPage)); },
      rowKey: (f) => `${M.flowKey(f)}|${f._site_id}`,

      sortBy(col) {
        if (!col.sort) return;
        const v = this.view;
        if (v.sortField === col.sort) v.sortDirection = v.sortDirection === "asc" ? "desc" : "asc";
        else { v.sortField = col.sort; v.sortDirection = col.numeric ? "desc" : "asc"; }
        v.page = 1;
      },
      ariaSort(col) { return this.view.sortField === col.sort ? (this.view.sortDirection === "asc" ? "ascending" : "descending") : null; },
      sortMark(col) { return this.view.sortField === col.sort ? (this.view.sortDirection === "asc" ? "▲" : "▼") : ""; },

      // One cell: its text, a second line, a tooltip and classes.
      cellText(key, f) {
        const n = this.namesNow;
        if (key === "action") return f.flow_action || "-";
        return M.columnValue(n, key, f);
      },
      cellSub(key, f) {
        const n = this.namesNow;
        if (key === "action") return M.dropReason(n, f)?.text || "";
        if (key === "assurance") return M.moveFromText(M.moveInfo(n, f));
        if (key === "path_change") { const p = M.previousPath(n, f); return p ? `from ${p.name}` : ""; }
        return "";
      },
      cellTip(key, f) {
        const n = this.namesNow;
        switch (key) {
          case "path": case "path_change": return M.pathTip(n, f);
          case "assurance": return M.assuranceTip(n, f);
          case "duration": return M.flowOpen(f) ? "Still open at the end of the searched range (End Reason: unknown), so this is how long it had been open, not its full length." : "";
          case "retx_pkts": return M.retxTip(f);
          case "retx_bytes": return M.directionTip(f, "retransmit_bytes");
          case "jitter": return M.directionTip(f, "avg_jitter");
          case "loss": return M.directionTip(f, "avg_packet_loss");
          case "mos": return M.directionTip(f, "avg_mos");
          case "action": return M.dropReason(n, f)?.detail || "";
          case "end_reason": return M.endReasonText(f) === "n/a" ? M.END_REASON_NA_TIP : "";
          default: return "";
        }
      },
      cellClass(col, f) {
        const text = this.cellText(col.key, f);
        return [col.mono && "mono", (text === "-" || text === "n/a" || (col.key === "retx_pkts" && M.retxProbes(f) && M.retxReal(f) === 0)) && "muted",
          col.key === "path_policy" || col.key === "security_policy" ? "c-accent" : col.key === "qos_policy" ? "c-warning" : ""];
      },
      pillClass(key, f) {
        const text = this.cellText(key, f);
        if (text === "-") return "";
        switch (key) {
          case "protocol": return `pill ${M.protocolClass(f.protocol)}`;
          case "init_success": return `pill ${f.init_success ? "pill-green" : "pill-red"}`;
          case "return_traffic": return `pill ${M.returnTrafficClass(text)}`;
          case "security": return `pill ${M.securityActions(f).includes("allow") ? "pill-green" : "pill-red"}`;
          default: return "";
        }
      },
      // A cell cut short by its column gets its full text as a tooltip (cells with their own keep theirs).
      clippedTip(ev) {
        const td = ev.target.closest("td");
        if (td && !td.title && td.scrollWidth > td.clientWidth) td.title = td.textContent.trim();
      },

      // ---- column widths ------------------------------------------------------------------------------

      // The widest header or cell of each column over every loaded flow, measured as flows arrive (only
      // the new and merged ones) and again when the names change.
      get columnWidths() {
        const deps = [this.searched, this.namesNow];
        let st = memo.widths;
        if (!sameDeps(st.deps, deps)) st = memo.widths = { deps, sites: {}, result: null, rev: -1 };
        if (st.result && st.rev === this.rev) return st.result;
        const n = this.namesNow;
        const maxes = Object.fromEntries(M.COLUMNS.map((c) => [c.key, this.headerWidth(c)]));
        for (const [siteId, entry] of Object.entries(store)) {
          let site = st.sites[siteId];
          if (!site || entry.flows.length < site.count) site = st.sites[siteId] = { count: 0, maxes: Object.fromEntries(M.COLUMN_KEYS.map((k) => [k, 0])) };
          const take = (f) => { for (const key of M.COLUMN_KEYS) { const w = this.cellWidth(n, key, f); if (w > site.maxes[key]) site.maxes[key] = w; } };
          for (let i = site.count; i < entry.flows.length; i++) take(entry.flows[i]);
          for (const f of entry.remeasure) take(f);
          entry.remeasure = [];
          site.count = entry.flows.length;
          for (const key of M.COLUMN_KEYS) if (site.maxes[key] > maxes[key]) maxes[key] = site.maxes[key];
        }
        st.rev = this.rev;
        st.result = Object.fromEntries(Object.entries(maxes).map(([k, w]) => [k, Math.ceil(w)]));
        return st.result;
      },
      // Header: 11px semibold uppercase with letter-spacing, the sort mark (14px), filter button (~20px) and padding,
      // plus a few pixels for the canvas measuring a little short of the rendered text.
      headerWidth(col) {
        const label = col.label.toUpperCase();
        return textWidth(label, 11, { weight: 600 }) + label.length * 0.44 + 14 + 20 + 24 + 4;
      },
      // Mirrors the cell markup: mono IPs, pills, a second line, the domain's copy button.
      cellWidth(n, key, f) {
        const PAD = 24 + 8;  // padding, and slack for the canvas measuring a little short
        const col = M.COLUMNS.find((c) => c.key === key);
        let text = key === "action" ? f.flow_action || "-" : M.columnValue(n, key, f);
        if (DIGIT_COLUMNS.has(key)) text = text.replace(/\d/g, "0");  // tabular digits: one width per format
        let w = col.pill && text !== "-" ? textWidth(text, 11, { weight: 500 }) + 12 : textWidth(text, 12, { mono: !!col.mono });
        if (key === "domain" && f.unknown_domain) w += 23;
        const sub = key === "action" || key === "assurance" || key === "path_change" ? this.cellSub(key, f) : "";
        if (sub) w = Math.max(w, textWidth(sub, 11));
        return w + PAD;
      },
      colWidth(key) {
        const auto = this.columnWidths[key];
        return this.userWidths[key] || (key === "path" ? Math.min(auto, PATH_MAX_WIDTH) : auto);
      },
      get tableWidth() { return this.visibleColumns.reduce((sum, c) => sum + this.colWidth(c.key), 0); },
      startResize(key, ev) {
        const handle = ev.currentTarget, startX = ev.clientX, startW = this.colWidth(key);
        handle.setPointerCapture(ev.pointerId);  // keeps the drag going off the handle; the release doesn't sort
        this.resizing = key;
        const move = (e) => { this.userWidths = { ...this.userWidths, [key]: Math.max(40, Math.round(startW + e.clientX - startX)) }; };
        const end = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          this.resizing = null;
          prefs.set("flows.columnWidths", JSON.stringify(this.userWidths));
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      },
      fitColumn(key) {
        this.userWidths = { ...this.userWidths, [key]: this.columnWidths[key] };
        prefs.set("flows.columnWidths", JSON.stringify(this.userWidths));
      },
      resetWidths() { this.userWidths = {}; prefs.set("flows.columnWidths", null); },
      get anyResized() { return Object.keys(this.userWidths).length > 0; },

      // ---- columns shown ------------------------------------------------------------------------------

      setHidden(changes) {
        const hidden = { ...this.hidden };
        for (const [key, hide] of Object.entries(changes)) { if (hide) hidden[key] = true; else delete hidden[key]; }
        if (M.COLUMN_KEYS.every((k) => hidden[k])) return;  // keep a column on screen
        this.hidden = hidden;
        prefs.set("flows.hiddenColumns", JSON.stringify(hidden));
      },
      groupShown(g) { return M.GROUPS[g].cols.every((k) => !this.hidden[k]); },
      // A toolbar button for a group not fully shown; End Reason only once a flow reports it.
      groupOffered(g) { return !this.groupShown(g) && (g !== "endreason" || this.endReasonReported); },
      toggleGroup(g) { const show = !this.groupShown(g); this.setHidden(Object.fromEntries(M.GROUPS[g].cols.map((k) => [k, !show]))); },
      get groupRuns() { return M.groupRuns(this.visibleKeys, this.hidden); },
      get statsSeparator() {
        const i = M.GROUP_ORDER.indexOf("flowstats"), offered = M.GROUP_ORDER.map((g) => this.groupOffered(g));
        return offered.slice(0, i).some(Boolean) && offered.slice(i).some(Boolean);
      },
      get anyGroupOffered() { return M.GROUP_ORDER.some((g) => this.groupOffered(g)); },
      get endReasonReported() {
        const active = this.activeFlows;
        if (memo.endReason.deps !== active) memo.endReason = { deps: active, value: active.some((f) => "session_end_reason" in f) };
        return memo.endReason.value;
      },
      get hiddenCount() { return Object.keys(this.hidden).length; },
      get viewIsDefault() {
        const def = M.defaultHidden();
        return !Object.keys(this.view.colFilters).length && M.COLUMN_KEYS.every((k) => !this.hidden[k] === !def[k]);
      },
      resetView() {
        this.hidden = M.defaultHidden();
        prefs.set("flows.hiddenColumns", JSON.stringify(this.hidden));
        this.clearFilters();
      },
      showAll() { this.hidden = {}; prefs.set("flows.hiddenColumns", "{}"); },
      openColMenu(ev) {
        if (this.colMenu.open) { this.colMenu.open = false; return; }
        const r = ev.currentTarget.getBoundingClientRect();
        this.colMenu = { open: true, x: Math.max(8, r.right - 220), y: r.bottom };
      },

      // ---- filters ----------------------------------------------------------------------------------------

      isFiltered(key) { return !!this.view.colFilters[key]; },
      get filterCount() { return this.visibleColumns.filter((c) => this.view.colFilters[c.key]).length; },
      clearFilters() { this.view.colFilters = {}; this.view.page = 1; },
      openFilter(col, ev) {
        const n = this.namesNow, current = this.view.colFilters[col.key];
        const flows = M.applyFilters(n, this.activeFlows, this.view, this.visibleKeys, [col.key]);
        const values = Object.freeze(M.filterValues(n, flows, col.key, current));
        const draft = Object.fromEntries((current || values.map((v) => v.value)).map((v) => [v, true]));
        const r = ev.currentTarget.getBoundingClientRect();
        this.colFilter = { open: true, key: col.key, label: col.label, values, search: "", draft,
          x: Math.max(8, Math.min(r.left, window.innerWidth - 290)), y: Math.min(r.bottom + 4, window.innerHeight - 390) };
        this.$nextTick(() => this.$refs.filterSearch?.focus());
      },
      get filterMatches() {
        const q = this.colFilter.search.trim().toLowerCase();
        return q ? this.colFilter.values.filter((v) => v.value.toLowerCase().includes(q)) : this.colFilter.values;
      },
      get filterShown() { return this.filterMatches.slice(0, FILTER_LIST_MAX); },
      get filterChecked() { return this.colFilter.values.filter((v) => this.colFilter.draft[v.value]).length; },
      toggleFilterValue(value) {
        const draft = { ...this.colFilter.draft };
        if (draft[value]) delete draft[value]; else draft[value] = true;
        this.colFilter.draft = draft;
      },
      setFilterMatches(on) {
        const draft = { ...this.colFilter.draft };
        for (const v of this.filterMatches) { if (on) draft[v.value] = true; else delete draft[v.value]; }
        this.colFilter.draft = draft;
      },
      applyFilter() {
        const cf = this.colFilter, selected = cf.values.filter((v) => cf.draft[v.value]).map((v) => v.value);
        const filters = { ...this.view.colFilters };
        // Everything checked = no filter, so flows that stream in later still show.
        if (selected.length === cf.values.length) delete filters[cf.key]; else filters[cf.key] = selected;
        this.view.colFilters = filters;
        this.view.page = 1;
        this.colFilter.open = false;
      },
      // Init failed / No return traffic / Flow moved: the column's filter set to one value (showing the
      // column, so it applies); again clears it.
      quickOn(key, value = "No") { const f = this.view.colFilters[key]; return !!f && f.length === 1 && f[0] === value; },
      toggleQuick(key, value = "No") {
        const filters = { ...this.view.colFilters };
        if (this.quickOn(key, value)) delete filters[key];
        else { filters[key] = [value]; this.setHidden({ [key]: false }); }
        this.view.colFilters = filters;
        this.view.page = 1;
      },

      // ---- summaries -------------------------------------------------------------------------------------

      get summaryCfg() { return this.summary.mode ? M.SUMMARIES[this.summary.mode] : null; },
      openSummary(mode) {
        this.summary = { mode, data: null, search: "", sort: this.summary.sort, open: {} };
        this.refreshSummary();
        this.$refs.summaryDialog.showModal();
      },
      refreshSummary() {
        const n = this.namesNow, cfg = this.summaryCfg;
        this.summary.data = Object.freeze(M.summarize(n, this.summary.mode, M.applyFilters(n, this.activeFlows, this.view, this.visibleKeys, cfg.skip)));
      },
      get summaryRows() {
        const s = this.summary, deps = [s.data, s.search, s.sort];
        if (sameDeps(memo.summary.deps, deps)) return memo.summary.value;
        const value = Object.freeze(M.summaryRows(s.data, s.search, s.sort));
        memo.summary = { deps, value };
        return value;
      },
      get summaryNote() {
        const d = this.summary.data;
        return d ? this.summaryCfg.note(d, d.groups.reduce((n, g) => n + g.subs.length, 0)) : "";
      },
      toggleSummaryGroup(key) {
        const open = { ...this.summary.open };
        if (open[key]) delete open[key]; else open[key] = true;
        this.summary.open = open;
      },
      // Narrow the table to a group's (or one row's) flows with the App / Domain column filters.
      filterToSummary(group, sub) {
        const filters = this.summaryCfg.filters(group, sub);
        this.setHidden(Object.fromEntries(Object.keys(filters).filter((k) => filters[k]).map((k) => [k, false])));
        const colFilters = { ...this.view.colFilters, ...filters };
        for (const k of Object.keys(filters)) if (filters[k] === null) delete colFilters[k];
        this.view.colFilters = colFilters;
        this.view.page = 1;
        this.$refs.summaryDialog.close();
      },

      // ---- tools --------------------------------------------------------------------------------------------

      downloadCsv() {
        if (!this.filteredFlows.length) return;
        saveFile(M.csvText(this.namesNow, this.filteredFlows, this.visibleKeys), "text/csv;charset=utf-8", `flows-${fileStamp()}.csv`);
      },
      showApiQuery() {
        this.apiQueryText = JSON.stringify(M.apiQuery(this.searched, this.searched.page_size), null, 2);
        this.$refs.queryDialog.showModal();
      },
      downloadApiQuery() { saveFile(this.apiQueryText, "application/json", `api-query-${fileStamp()}.json`); },
      copy(text) { navigator.clipboard?.writeText(text).catch(() => {}); },
      // HELP, at the top or at a section (the columns, from the table's toolbar).
      openHelp(section) {
        const d = this.$refs.helpDialog;
        d.showModal();
        const el = section && d.querySelector(`#${section}`);
        if (el) el.scrollIntoView({ block: "start" }); else d.scrollTo(0, 0);
      },
    };
  });
});
