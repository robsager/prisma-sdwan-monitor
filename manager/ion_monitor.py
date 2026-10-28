"""ION Connectivity Monitor: a log of IONs going offline and coming back, kept by the server.

1.x compared device polls in each browser tab, so events were seen only while a tab was polling
(background tabs are slowed to about one check a minute), two tabs logged them twice, and the log
lived in one browser. Here one watcher thread per tenant compares the tenant's ION list (one call,
shared with the pages' device polls) with the previous one, and every tab reads the same log from
data/ion-monitor-<tsg>.json. Pages only fetch what changed since their last poll (rev).

Times are the controller's: it rewrites an element record on every connect and disconnect
(verified live), so a flip's time is the record's _updated_on_utc, not when someone looked. The
last state of every ION is saved too, so a change while nobody was watching (Manager closed, tab
hidden) is still logged when watching resumes, marked "away".

An ION back online has its status read once (did it reboot, and the controller's own outage
times). A reconnect the controller never showed (an ION losing power stays "connected" until it
reconnects, seen live) shows as a changed record while connected: its status is read and the
reconnect logged if it rebooted or was offline for MISSED_MIN_DOWN_S or more.

Serial watch: serial numbers checked through the tenant's machines list (all its hardware, claimed
or not), for IONs not at a site, including a new one before it is claimed.
"""
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone

from . import config
from .api.cache import CacheError
from .api.client import ApiError
from .api.pacing import set_background
from .config import V
from .timeutil import iso, parse_iso, utc_ticks

UNCLAIMED_TEXT = "Not claimed yet: the controller has no status for it"


def _ms(a, b):
    """b - a in ms, for ISO times."""
    return round((parse_iso(b) - parse_iso(a)).total_seconds() * 1000)


def _reboot_since(st, start_iso):
    """{at, info} when the ION last rebooted from REBOOT_WINDOW before start_iso, else {none}."""
    start = parse_iso(start_iso) - config.REBOOT_WINDOW
    if st.get("last_reboot") and parse_iso(st["last_reboot"]) >= start:
        return {"at": st["last_reboot"], "info": st.get("last_reboot_info")}
    return {"none": True}


def log_path(tsg_id):
    return os.path.join(config.DATA_DIR, f"ion-monitor-{tsg_id}.json")


def forget(tsg_id):
    """A deleted tenant's log goes too."""
    try:
        os.remove(log_path(tsg_id))
    except OSError:
        pass


class IonMonitor:
    def __init__(self, svc, clock=time.time, autostart=True, path=None):
        self.svc = svc
        self._clock = clock
        self._autostart = autostart
        self._path = path or log_path(svc.tsg_id)
        self._lock = threading.Lock()
        self._changed = threading.Condition(self._lock)  # a page waiting for the next change (poll's wait_s)
        self._save_lock = threading.Lock()
        self._wake = threading.Event()
        doc = self._load()
        self._events = doc.get("events") or []         # newest first (by time)
        self._known = doc.get("known") or {}           # element id -> [connected, _updated_on_utc ticks]
        self._serial_known = doc.get("serial_known") or {}  # serial -> [connected, updated ticks]
        self._serials = doc.get("serials") or []
        self._rev = doc.get("rev") or 1  # 0 asks for the whole log
        self._next_id = doc.get("next_id") or 1
        self._log_id = doc.get("log_id") or uuid.uuid4().hex[:12]
        self._pending = []                             # [(due epoch s, event id)]: reboot checks
        self._serial_status = None
        self._checked_at = None
        self._checks = 0                               # finished checks, so a waiting page also hears "checked"
        self._error = None
        self._last_step = None
        self._used_at = None
        self._watch_at = None
        self._thread = None
        self._closed = False

    # ---- page calls -----------------------------------------------------------------------------

    def poll(self, since=0, log_id=None, watch=False, wait_s=0):
        """What changed since rev `since` (new and updated events), or the whole log when since is 0
        or the log was cleared (log_id differs). Keeps the watcher running, every WATCH_POLL_S when
        watch is on. wait_s: when nothing changed yet, wait up to this long and answer the moment an
        event is logged or the next check ends (a browser slows a background tab's timers, not its
        open requests, so the alert isn't held back)."""
        now = self._clock()
        with self._lock:
            self._used_at = now
            faster = watch and not self._watching(now)
            if watch:
                self._watch_at = now
        self._ensure_thread()
        if faster:
            self._wake.set()  # Watch IONs just turned on: check now, then every WATCH_POLL_S
        with self._lock:
            if wait_s and since and log_id == self._log_id:
                checks = self._checks
                self._changed.wait_for(lambda: self._rev > since or self._checks != checks or self._closed
                                       or self._log_id != log_id, timeout=wait_s)
            full = not since or log_id != self._log_id
            events = [dict(e) for e in self._events if full or e["rev"] > since]
            return {
                "log_id": self._log_id, "rev": self._rev, "full": full, "events": events,
                "checked_at": self._checked_at, "error": self._error,
                "interval_s": config.WATCH_POLL_S if self._watching(self._clock()) else config.MONITOR_POLL_S,
                "serials": list(self._serials), "serial_status": self._serial_status,
            }

    def set_serials(self, serials):
        wanted = [s for s in dict.fromkeys(str(s).strip().upper() for s in serials) if s]
        if len(wanted) > config.MAX_WATCH_SERIALS:
            raise ValueError(f"at most {config.MAX_WATCH_SERIALS} serial numbers")
        with self._lock:
            self._serials = wanted
            self._serial_known = {s: v for s, v in self._serial_known.items() if s in wanted}
            self._serial_status = None
            self._bump()
        self._save()
        self._wake.set()
        return {"serials": wanted}

    def clear(self):
        with self._lock:
            self._events = []
            self._pending = []
            self._log_id = uuid.uuid4().hex[:12]
            self._bump()
        self._save()
        return {"log_id": self._log_id}

    def close(self):
        self._closed = True
        self._wake.set()
        with self._lock:
            self._changed.notify_all()

    # ---- watcher --------------------------------------------------------------------------------

    def _watching(self, now):
        return self._watch_at is not None and now - self._watch_at < config.WATCH_LEASE_S

    def _active(self, now):
        return self._watching(now) or (self._used_at is not None and now - self._used_at < config.MONITOR_IDLE_S)

    def _ensure_thread(self):
        if not self._autostart or self._closed or (self._thread and self._thread.is_alive()):
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f"ion-monitor-{self.svc.tsg_id}")
        self._thread.start()

    def _loop(self):
        set_background(True)
        while not self._closed and self._active(self._clock()):
            try:
                self.step()
            except Exception as e:  # noqa: BLE001 - never let the watcher die; the next check retries
                with self._lock:
                    self._error = str(e) or type(e).__name__
            now = self._clock()
            with self._lock:
                wait = config.WATCH_POLL_S if self._watching(now) else config.MONITOR_POLL_S
                if self._pending:
                    wait = min(wait, max(0.5, min(d for d, _ in self._pending) - now))
            self._wake.wait(wait)
            self._wake.clear()

    def step(self):
        """One check: compare the IONs (and watched serials) with the last check, log what changed and
        run the reboot checks that are due. A failed check keeps the last state and says why."""
        now = self._clock()
        try:
            self._check(now)
            error = None
        except (ApiError, CacheError) as e:
            error = str(e)
        with self._lock:
            self._error = error
        self._run_due(now)

    def _check(self, now):
        # Continuous: the previous check was recent, so a changed record means a change since then.
        # Otherwise (first check after a pause or a restart) only state flips are logged, as "away".
        continuous = self._last_step is not None and now - self._last_step <= 3 * config.MONITOR_POLL_S
        fetched_at, elements = self.svc.elements(max_age=config.WATCH_POLL_S - 1 if self._watching(now) else config.ELEMENTS_CACHE_S)
        names = {s["id"]: s.get("name") or s["id"] for s in self.svc.sites()}
        by_id = {e["id"]: e for e in elements}
        fresh, reconnects, known = [], [], {}
        for e in elements:
            if e.get("site_id") not in names:
                continue  # not at a site (spare IONs): serial watch covers them
            cur = [bool(e.get("connected")), e.get("_updated_on_utc")]
            known[e["id"]] = cur
            ion = {"site_id": e["site_id"], "site": names[e["site_id"]], "device_id": e["id"],
                   "device": e.get("name") or e.get("serial_number") or e["id"], "serial": e.get("serial_number")}
            self._compare(ion, self._known.get(e["id"]), cur, fetched_at, continuous, fresh, reconnects, e)
        serial_status = self._check_serials(names, by_id, fetched_at, continuous, fresh, reconnects) if self._serials else None
        for ion, since, element in reconnects:
            ev = self._reconnect_event(ion, since, element, fetched_at)
            if ev:
                fresh.append(ev)
        with self._lock:
            changed = known != self._known
            self._known = known
            self._checked_at = fetched_at
            self._last_step = now
            self._checks += 1
            self._changed.notify_all()
            if serial_status is not None:
                self._serial_status = serial_status
            for ev in fresh:
                self._add(ev, now)
        if fresh or changed:
            self._save()

    def _compare(self, ion, before, cur, seen_at, continuous, fresh, reconnects, element=None):
        if before is None:
            return  # first sight: nothing to compare with
        if before[0] == cur[0]:
            if cur[0] and continuous and element and before[1] and cur[1] and cur[1] != before[1]:
                reconnects.append((ion, utc_ticks(before[1]), element))
            return
        # The record's new time is the flip's, when it moved on (else when it was seen).
        at = utc_ticks(cur[1]) if isinstance(cur[1], (int, float)) and isinstance(before[1], (int, float)) \
            and cur[1] > before[1] and utc_ticks(cur[1]) <= seen_at else seen_at
        ev = {**ion, "at": at, "seen_at": seen_at, "up": cur[0]}
        if not continuous:
            ev["away"] = True
        if cur[0]:
            down = next((x for x in self._events if x["device_id"] == ion["device_id"]), None)
            if down and not down["up"]:
                ev["down_ms"] = max(0, _ms(down["at"], at))
                ev["down_at"] = down["at"]
            if element is None:
                ev["reboot"] = {"unknown": UNCLAIMED_TEXT}
        fresh.append(ev)

    def _check_serials(self, names, by_id, fetched_at, continuous, fresh, reconnects):
        machines = self.svc.cache.get("machines", config.MACHINES_CACHE_S,
                                      lambda: self.svc.client.get_items(f"/sdwan/{V.MACHINES}/api/machines"))
        by_serial = {(m.get("sl_no") or m.get("hw_id") or "").upper(): m for m in machines}
        status, known = [], {}
        for s in self._serials:
            m = by_serial.get(s)
            if m is None:
                status.append({"serial": s, "found": False})
                known[s] = [False, None]  # not in the tenant = not connected
                continue
            e = by_id.get(m.get("em_element_id")) or {}
            site_id = e.get("site_id") if e.get("site_id") in names else None
            row = {"serial": s, "found": True, "connected": bool(m.get("connected")), "state": m.get("machine_state"),
                   "model": m.get("model_name"), "element_id": e.get("id"), "name": e.get("name"),
                   "site_id": site_id, "site": names.get(site_id)}
            status.append(row)
            cur = [row["connected"], m.get("_updated_on_utc")]
            known[s] = cur
            if site_id:
                continue  # at a site: the site watch logs it
            ion = {"site_id": None, "site": "no site" if e else "not claimed", "device_id": e.get("id") or f"serial:{s}",
                   "device": e.get("name") or s, "serial": s, "serial_watch": True}
            if not e:
                ion["unclaimed"] = True
            self._compare(ion, self._serial_known.get(s), cur, fetched_at, continuous, fresh, reconnects, e or None)
        with self._lock:
            self._serial_known = known
        return status

    # ---- status checks --------------------------------------------------------------------------

    def _status(self, element):
        """(the ION's elements/{id}/status as devices.element_status, None) or (None, why not).
        Shared with Site details' Devices table, which then needn't ask again."""
        health = self.svc.site_health
        if health._status_forbidden():
            return None, "this service account's role can't read ION status (403)"
        err = health._fetch_status(element)
        return (None, err) if err else (health._cached_status(element, any_age=True), None)

    def _reconnect_event(self, ion, since, element, seen_at):
        st, _ = self._status(element)
        cs = (st or {}).get("connected_since")
        if not cs or not since or parse_iso(cs) <= parse_iso(since):
            return None
        disc = st.get("disconnected_at")
        down_ms = _ms(disc, cs) if disc and parse_iso(disc) > parse_iso(since) else None
        reboot = _reboot_since(st, disc or cs)
        if reboot.get("none") and not (down_ms is not None and down_ms >= config.MISSED_MIN_DOWN_S * 1000):
            return None  # a short reconnect without a reboot: common, left out
        with self._lock:
            if any(e["device_id"] == ion["device_id"] and e["at"] == cs for e in self._events):
                return None
        ev = {**ion, "at": cs, "seen_at": seen_at, "up": True, "missed": True, "reboot": reboot}
        if down_ms is not None and down_ms >= 1000:
            ev["controller_down_ms"] = down_ms
        return ev

    def _run_due(self, now):
        with self._lock:
            due = [eid for d, eid in self._pending if d <= now]
            self._pending = [(d, eid) for d, eid in self._pending if d > now]
        if not due:
            return
        try:
            elements = {e["id"]: e for e in self.svc.elements()[1]}
        except (ApiError, CacheError) as e:
            elements, err = {}, str(e)
        else:
            err = "the ION is no longer in the tenant"
        for eid in due:
            with self._lock:
                ev = next((x for x in self._events if x["id"] == eid), None)
            if ev is None:
                continue  # cleared meanwhile
            element = elements.get(ev["device_id"])
            st, why = self._status(element) if element else (None, err)
            if st is None:
                update = {"reboot": {"unknown": why}}
            else:
                # Without a logged offline event (opened mid-outage), from the controller's disconnect.
                start = ev.get("down_at") or st.get("disconnected_at") or ev["at"]
                update = {"reboot": _reboot_since(st, start)}
                disc, cs = st.get("disconnected_at"), st.get("connected_since")
                if disc and cs and parse_iso(disc) >= parse_iso(start) - config.REBOOT_WINDOW:
                    update["controller_down_ms"] = max(0, _ms(disc, cs))
            with self._lock:
                self._bump()
                ev.update(update, rev=self._rev)
        self._save()

    # ---- the log --------------------------------------------------------------------------------

    def _bump(self):
        """A change to the log (lock held): a new rev, and waiting pages answer."""
        self._rev += 1
        self._changed.notify_all()

    def _add(self, ev, now):
        """Log one event (lock held): newest first by time, at most ION_EVENTS_MAX."""
        self._bump()
        ev.update(id=self._next_id, rev=self._rev)
        self._next_id += 1
        self._events.append(ev)
        self._events.sort(key=lambda e: (e["at"], e["id"]), reverse=True)
        del self._events[config.ION_EVENTS_MAX:]
        if ev["up"] and "reboot" not in ev:
            self._pending.append((now + config.REBOOT_CHECK_DELAY_S, ev["id"]))

    def _load(self):
        try:
            with open(self._path, encoding="utf-8") as f:
                doc = json.load(f)
            return doc if isinstance(doc, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self):
        with self._lock:
            doc = {"log_id": self._log_id, "rev": self._rev, "next_id": self._next_id, "events": self._events,
                   "known": self._known, "serial_known": self._serial_known, "serials": self._serials,
                   "saved_at": iso(datetime.now(timezone.utc))}
            body = json.dumps(doc, separators=(",", ":"))
        with self._save_lock:
            try:
                os.makedirs(os.path.dirname(self._path), exist_ok=True)
                tmp = self._path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(body)
                os.replace(tmp, self._path)
            except OSError:
                pass  # the log stays in memory; the next change tries again
