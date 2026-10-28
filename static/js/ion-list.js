// The Overview's ION list: every ION at every site, opened from the "Devices online" tile's
// "N disconnected", filtered to disconnected. Built from the Overview's own device data (refreshed
// every 20 s), so it costs no calls.

import { minuteLabel } from "./format.js";

export function ionList() {
  return {
    ionList: { status: "disconnected", query: "" },

    openIonList(status = "disconnected") {
      this.ionList = { status, query: "" };
      this.$refs.ionListDialog.showModal();
    },

    get ionListView() {
      const all = (this.overview?.sites || []).flatMap((s) => s.devices.map((d) => ({
        key: d.id, name: d.name, serial: d.serial || "", model: (d.model || "").toUpperCase(), software: d.software || "",
        site: s.name, siteHref: this.siteHref(s), connected: d.connected,
        // The element record is rewritten on each connect and disconnect, so its last change is when the state began.
        since: d.updated ? minuteLabel(d.updated) : "",
      })));
      const down = all.filter((r) => !r.connected).length;
      const terms = this.ionList.query.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
      const rows = all
        .filter((r) => this.ionList.status === "all" || (this.ionList.status === "disconnected") === !r.connected)
        .filter((r) => !terms.length || terms.some((t) => `${r.name} ${r.serial} ${r.site} ${r.model}`.toLowerCase().includes(t)))
        .sort((a, b) => a.connected - b.connected || a.site.localeCompare(b.site) || a.name.localeCompare(b.name));
      return {
        rows,
        chips: [
          { key: "disconnected", label: "Disconnected", n: down, cls: "c-critical" },
          { key: "connected", label: "Connected", n: all.length - down, cls: "c-good" },
          { key: "all", label: "All", n: all.length, cls: "" },
        ],
      };
    },
  };
}
