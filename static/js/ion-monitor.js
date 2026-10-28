// ION Connectivity Monitor, mixed into the page component: the header button, the dialog, pop-ups and
// sound. The server watches the IONs and keeps the log. This page keeps one request open to it, which
// the server answers the moment an event is logged or a check ends (WAIT_S at most), then asks again
// at once: no timer between them, so a background tab (whose timers the browser slows to about one a
// minute) still alerts within a second or two. A local call: the server's own checks set the API calls.
// Normally only while the tab is visible; with Watch IONs on also in the background.

import { api, prefs, tenantPath } from "./api.js";
import {
  RETRY_MS, SOUND_NOTES, WAIT_S, alerts, eventToast, filterSummary, filterTerms, logView, mergeLog, parseSerials, rebootNote, serialRows,
} from "./ion-monitor-model.js";

// Watch IONs and the filter last for this tab, as in 1.x; sound is remembered in this browser.
const session = {
  get(key, fallback = null) { try { return sessionStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* ignore */ } },
};

const blankLog = (tsg = null) => ({ tsg, logId: null, rev: 0, events: null, checkedAt: null, error: "", intervalS: null,
  serials: [], serialStatus: null, serialError: "" });

let audioCtx = null;
function playSound(kind) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { return; }
  let t = audioCtx.currentTime + 0.05;
  for (const f of SOUND_NOTES[kind]) {
    if (f) {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    }
    t += 0.22;
  }
}
// Browsers play sound only after a click on the page: resume the audio on any click.
document.addEventListener("click", () => { if (audioCtx?.state === "suspended") audioCtx.resume(); });

export const ionMonitor = () => ({
  ionLog: blankLog(),
  ionWatch: session.get("sdwan.ionWatch") === "1",
  ionSound: prefs.get("sdwan.ionSound") === "1",
  ionFilter: session.get("sdwan.ionFilter", ""),
  ionSerialsText: "",
  ionUnseen: 0,
  ionTimer: null,
  ionAbort: null,     // the open request; a new poll replaces it
  ionNoWait: false,   // the next request answers at once (Watch IONs just changed)

  // ---- derived ----------------------------------------------------------------------------------

  get ionTerms() { return filterTerms(this.ionFilter); },
  get ionView() { return logView(this.ionLog.events, this.ionTerms, this.secNow); },
  get ionFilterSummary() { return filterSummary(this.overview?.sites || [], this.ionTerms); },
  get ionSerialRows() { return serialRows(this.ionLog.serialStatus); },
  get ionButtonTitle() {
    return this.ionWatch
      ? `Watching: ION status every 5 s, also in the background${this.ionSound ? ", with sound" : ""}. Click for the log or to stop.`
      : "Log of IONs going offline and coming back; turn on Watch IONs there for 5-second checks and sound";
  },

  // ---- polling ----------------------------------------------------------------------------------

  startIonMonitor() {
    if (this.ionLog.tsg !== this.tsg) { this.ionLog = blankLog(this.tsg); this.ionUnseen = 0; this.updateTitle(); }
    this.pollIon();
  },

  stopIonMonitor() {
    clearTimeout(this.ionTimer);
    this.ionTimer = null;
    this.ionAbort?.abort();
    this.ionAbort = null;
  },

  // The tab is shown again: start polling unless a request is already open (aborting it would leave
  // the server waiting on it for nothing).
  resumeIon() { if (!this.ionAbort) this.pollIon(); },

  async pollIon() {
    this.stopIonMonitor(); // replaces the open request (tenant switch, Watch IONs, Clear log, tab shown)
    const tsg = this.tsg;
    if (!tsg) return;
    if (document.hidden && !this.ionWatch) return; // resumed by visibilitychange
    const ctrl = (this.ionAbort = new AbortController());
    const log = this.ionLog;
    const wait = log.events && !this.ionNoWait ? WAIT_S : 0;
    this.ionNoWait = false;
    let retry = false;
    try {
      const q = `?since=${log.events ? log.rev : 0}&log=${encodeURIComponent(log.logId || "")}&watch=${this.ionWatch ? 1 : 0}&wait=${wait}`;
      const resp = await api("GET", tenantPath(tsg, `/ion-monitor${q}`), undefined, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (this.tsg === tsg && this.ionLog === log) this.applyIon(resp);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (this.tsg === tsg) this.ionLog.error = err.message; // keep the last log on screen
      retry = true;
    }
    if (this.ionAbort !== ctrl || this.tsg !== tsg) return;
    this.ionAbort = null;
    if (retry) this.ionTimer = setTimeout(() => this.pollIon(), RETRY_MS);
    else this.pollIon();
  },

  applyIon(resp) {
    const log = this.ionLog;
    const { events, fresh, rebooted } = mergeLog(log.events, resp);
    Object.assign(log, { logId: resp.log_id, rev: resp.rev, events, checkedAt: resp.checked_at, error: resp.error || "",
      intervalS: resp.interval_s, serials: resp.serials, serialStatus: resp.serial_status });
    if (document.activeElement !== this.$refs.ionSerials) this.ionSerialsText = resp.serials.join(", ");
    if (fresh.length) this.devicePoll?.now(); // the Overview's device status too, without waiting for its 20 s
    const shown = fresh.filter((e) => alerts(e, this.ionTerms));
    for (const ev of shown) this.toast(eventToast(ev, ev.missed && ev.reboot?.at ? rebootNote(ev) : null));
    for (const ev of rebooted.filter((e) => alerts(e, this.ionTerms))) this.toast(eventToast(ev, rebootNote(ev)));
    if (shown.length) {
      if (!this.$refs.ionDialog?.open) this.ionUnseen += shown.length;
      this.updateTitle();
      if (this.ionWatch && this.ionSound) playSound(shown.some((e) => !e.up) ? "down" : "up");
    }
  },

  // The tab's title: the open site's name, and the events not seen yet.
  updateTitle() {
    const page = this.route.name === "site" ? `${this.siteName(this.route.siteId)} · Prisma SD-WAN` : "Prisma SD-WAN";
    document.title = this.ionUnseen ? `(${this.ionUnseen}) ${page}` : page;
  },

  // ---- dialog -----------------------------------------------------------------------------------

  openIonMonitor() {
    this.ionUnseen = 0;
    this.updateTitle();
    this.$refs.ionDialog.showModal();
  },

  setIonWatch(on) {
    this.ionWatch = on;
    session.set("sdwan.ionWatch", on ? "1" : "0");
    if (on && this.ionSound) playSound("up"); // this change is a click, so it also unlocks the audio
    this.ionNoWait = true;
    this.pollIon(); // tells the server at once
  },

  setIonSound(on) {
    this.ionSound = on;
    prefs.set("sdwan.ionSound", on ? "1" : "0");
    if (on) playSound("up");
  },

  testIonSound() { playSound("down"); },

  setIonFilter(text) { this.ionFilter = text; session.set("sdwan.ionFilter", text); },

  async saveIonSerials() {
    const serials = parseSerials(this.ionSerialsText);
    if (serials.join(",") === this.ionLog.serials.join(",")) return;
    try {
      const r = await api("PUT", tenantPath(this.tsg, "/ion-monitor/serials"), { serials });
      this.ionLog.serials = r.serials;
      this.ionLog.serialStatus = null;
      this.ionLog.serialError = "";
      this.ionSerialsText = r.serials.join(", ");
      this.ionNoWait = true;
      this.pollIon();
    } catch (err) {
      this.ionLog.serialError = err.message;
    }
  },

  async clearIonLog() {
    if (!confirm("Clear the ION event log for this tenant? It is shared by every browser using this Monitor.")) return;
    try {
      await api("DELETE", tenantPath(this.tsg, "/ion-monitor/events"));
      this.ionLog.events = null; // the next poll loads the new, empty log
      this.pollIon();
    } catch (err) {
      this.toast(`Couldn't clear the log: ${err.message}`, "error");
    }
  },
});
