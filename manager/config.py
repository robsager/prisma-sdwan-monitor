"""Settings and tunables in one place.

Environment variables (all optional):
  PORT              port to listen on (default 5050)
  MANAGER_DATA_DIR  where tenants.json and caches live (default: <app>/data)
  PRISMA_AUTH_URL   token endpoint
  PRISMA_API_BASE   API base URL
"""
import os
from datetime import timedelta

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("MANAGER_DATA_DIR") or os.path.join(APP_DIR, "data")
PORT = int(os.environ.get("PORT", 5050))

with open(os.path.join(APP_DIR, "VERSION"), encoding="utf-8") as f:
    VERSION = f.read().strip()

AUTH_URL = os.environ.get("PRISMA_AUTH_URL", "https://auth.apps.paloaltonetworks.com/auth/v1/oauth2/access_token")
API_BASE = os.environ.get("PRISMA_API_BASE", "https://api.sase.paloaltonetworks.com").rstrip("/")


class V:
    """Per-resource API versions (the prisma_sase SDK defaults; verified live with 1.x)."""
    PROFILE = "v2.1"
    TENANT = "v2.12"
    SITES = "v4.13"
    ELEMENTS = "v3.2"
    WANIF = "v2.10"
    WANNET = "v2.1"
    WANLABEL = "v2.6"
    METRICS = "v2.7"
    EVENTS = "v3.7"
    ELEMENT_STATUS = "v2.2"   # elements/{id}/status: connection times, last reboot
    MACHINES = "v2.5"         # machines: every ION in the tenant's hardware, claimed or not
    SPOKECLUSTERS = "v2.0"    # sites/{id}/spokeclusters/{id}/status: branch HA roles
    SYS_METRICS = "v2.4"      # monitor/sys_metrics: ION CPU, memory, disk, temperatures
    TOPOLOGY = "v3.6"         # topology: fabric link names
    APPDEFS = "v2.6"          # appdefs: app id -> name
    APPSTATS = "v2.0"         # monitor/applicationstats/query: every app's counts at a site
    AGGREGATES = "v3.0"       # monitor/aggregates PrefixList: per-prefix app events
    PROBEPROFILES = "v2.0"    # probeprofiles: which probe configs a circuit (or its label) runs
    PROBECONFIGS = "v2.1"     # probeconfigs: each probe's endpoints and path types
    PROBE_METRICS = "v2.0"    # monitor/metrics/probes: ProbeLatency / ProbeJitter per probe config and path
    VPNLINK_STATUS = "v2.2"   # vpnlinks/{id}/status: which of a fabric link's tunnels is active
    PERFSETS = "v2.0"         # perfmgmtpolicysets: performance policy sets...
    PERFRULES = "v2.3"        # ...their rules (Move Flows)...
    PERFTHRESHOLDS = "v2.1"   # ...and threshold profiles (a probe's latency limit)
    AIOPS = "v2.0"            # monitor/aiops/health: site, app and link health as in SCM
    AIOPS_STATS = "v2.1"      # monitor/aiops/object_stats and aggregates: an app's score, sites and counters
    # monitor/flows (with session_end_reason and sec_policy_actions). Flow history is supported for
    # 90 days, so searches stay inside that (FLOW_MAX_AGE).
    FLOWS = "v3.11"
    NETPOLICYSETS = "v2.0"    # path (network) policy sets...
    NETPOLICYRULES = "v2.5"   # ...and rules (rule id -> name for Flow Search)
    PRIOPOLICYSETS = "v2.0"   # QoS (priority) policy
    PRIOPOLICYRULES = "v2.2"
    SECPOLICYSETS = "v2.0"    # security (NGFW) policy
    SECPOLICYRULES = "v2.3"


# SD-WAN tenant telemetry_region -> X-PANW-Region (the SDK's map; unknown values pass through).
REGION_MAP = {"us": "americas", "eu": "europe"}

# ---- Request pacing (per tenant) ---------------------------------------------------------------
# Token bucket shared by every request; background work can't take the last BG_RESERVE tokens, so
# what someone is looking at goes first.
RATE_PER_S = 5.0
RATE_BURST = 10
BG_RESERVE = 3
# Monitor endpoints limit concurrent requests (measured: monitor/aggregates returned 429s for 17 of
# 33 calls with ~6 at once, none sequentially; monitor/metrics returned 429s at 3-4 in flight and
# occasionally at 2, without Retry-After, live check 2026-10-26). A 429 lowers a family's cap by
# one, not below its GATE_MIN, until GATE_RELAX_S pass without one, and pauses that family for its
# Retry-After (or the backoff when there is none). The 429s come in short bursts: relaxing after
# 10 minutes kept Top applications' 30 RTT queries at 1 at a time (130 s; live check 2026-10-27).
# monitor/metrics/probes has a gate of its own: held at metrics' 2, five sites' probes took 1.65x
# 1.x's time (6 in flight); at 4, 40-60% of the queries drew 429s and it was no faster; 3 took 0.83x
# (live check 2026-10-27).
# monitor/flows allows about 2 requests at once (verified live with 1.x: 3 drew 429s and fetched
# less, 0.18 vs 0.25 requests/s); the gate is per tenant, so two tabs searching share it.
# monitor/aiops returns 429s sooner than the rest (live check 2026-10-27: pace it at about 1/s).
ENDPOINT_CONCURRENCY = {"aggregates": 2, "metrics": 2, "probes": 3, "appstats": 2, "flows": 2, "aiops": 2, "other": 6}
GATE_MIN = {"metrics": 1, "flows": 1, "aiops": 1}     # families not listed: 2
GATE_RELAX_S = 60
MAX_ATTEMPTS = 7
REQUEST_TIMEOUT_S = 60
MAX_WORKERS = 6

# ---- Caches (seconds) ----------------------------------------------------------------------------
ELEMENTS_CACHE_S = 5          # ION status: shared by device polls (every 20 s), the Overview, Site details
SITES_CACHE_S = 55            # under WARM_INTERVAL_S, so every warmer run sees current admin_state
TENANT_CONFIG_CACHE_S = 600   # WAN networks (rarely change)
OVERVIEW_BW_CACHE_S = 300     # Overview utilization
WARM_INTERVAL_S = 60          # background warmer keeps the Overview fresh while the app is in use...
WARM_IDLE_S = 600             # ...and stops after this long without a page request
OVERVIEW_CACHE_S = WARM_INTERVAL_S + 15  # outlives a warmer cycle, so page polls never rebuild it

# ---- Data ------------------------------------------------------------------------------------------
MAX_ALARM_PAGES = 20          # standing alarms, 100 per page (the API's maximum)
WANIF_PAGE = 100              # waninterfaces/query returns 100 by default; paged with dest_page
MAX_WANIF_PAGES = 50
METRICS_BATCH = 10            # the API caps filter.site / filter.waninterface arrays at 10 items
LIVE_LOOKBACK = timedelta(minutes=10)  # newest minutes are fetched over this window (covers ingest delay)
STEP_SECONDS = 60             # metrics are 1-minute points

# ---- Site details: circuits --------------------------------------------------------------------
# Every metric of an open site's circuits is kept as a rolling 24 h of 1-minute points; the period
# selector slices it, so changing the period costs no API calls.
HISTORY_WINDOW = timedelta(hours=24)
SITE_WINDOWS_H = (1, 4, 12, 24)
LIVE_CACHE_S = 8              # tabs showing the same site share one top-up
STALE_AFTER = timedelta(minutes=15)    # no quality data this recent: a quiet or offline circuit...
STALE_RECHECK_S = 60                   # ...re-queried at most this often, and one with no quality
EMPTY_RECHECK_S = 300                  # data in 24 h at most this often (live: 2 of 3 circuits at a site)
# With every circuit's saved series this recent (memory, else data/cache.db) the site opens from
# it at once and the first live update fetches the missing minutes (a metrics query costs the same
# for 5 minutes as for 24 hours).
INCREMENTAL_MAX_GAP = timedelta(hours=6)
RESUME_OVERLAP = timedelta(minutes=5)  # resume this far before a circuit's last complete fetch
PERSIST_EVERY_S = 120         # an open site's series are saved this often
SITE_IDLE_S = 3600            # sites not viewed this long leave memory (saved first)...
EVICT_CHECK_S = 300           # ...checked this often
CACHE_MAX_AGE_S = 7 * 86400   # data/cache.db rows not saved this long are dropped
# Spikes: minutes at least `ratio` x the circuit's own median over the period and `over` above it,
# merged when under SPIKE_GAP apart. Relative to the circuit, so a jump from ~45 ms to 160 ms
# counts though it's under the 150 ms warning threshold. Loss is usually 0, so its rule is in
# effect "0.5+ points of loss".
SPIKE_RULES = {"latency": (2, 50), "loss_down": (2, 0.5), "loss_up": (2, 0.5)}
SPIKE_GAP = timedelta(minutes=3)
SPIKES_KEPT = 20

# ---- Site details: devices and alarms ------------------------------------------------------------
# Per site: one sys_metrics query (connected IONs) + one HA status per pair. A little under the page's
# 2-minute poll, as a cache entry dates from when its fetch ended (live: at 120 every other poll was cached).
DEVICE_HEALTH_CACHE_S = 110
SYS_METRICS_LOOKBACK = timedelta(minutes=30)  # each metric's newest 5-minute average in this window
# elements/{id}/status (uptime, connection times) is asked again only when the ION's element record
# changes (the controller rewrites it on every connect and disconnect, so also after a reboot) or
# after STATUS_MAX_AGE_S. 1.x asked for every ION every 2 minutes.
STATUS_MAX_AGE_S = 600
STATUS_FORBIDDEN_RETRY_S = 1800  # after a 403 (a role without element status), try again this much later
STANDING_CACHE_S = 55         # active alarms: shared by the Overview build and Site details
ALARM_HISTORY_CACHE_S = 110   # per site: alarms cleared in the last 24 h (events/query, paged), every other alarms poll
TOPOLOGY_CACHE_S = 3600       # fabric link names, fetched only for a link alarm at the open site...
TOPOLOGY_RETRY_S = 300        # ...and again at most this often while one of its links is unknown
TOPOLOGY_MAP_CACHE_S = 55     # the Overview's Map: one topology call for the tenant, polled every 60 s while shown

# ---- ION Connectivity Monitor -----------------------------------------------------------------------
# A watcher thread per tenant compares the tenant's ION list (one call, shared with the device polls)
# with the previous one and logs each ION going offline or coming back, in data/ion-monitor-<tsg>.json.
# It runs while a page has asked for the log in the last MONITOR_IDLE_S, checking every
# MONITOR_POLL_S, or every WATCH_POLL_S while a tab with Watch IONs on has asked in the last WATCH_LEASE_S
# (a background tab may be slowed to about one request a minute by the browser).
MONITOR_POLL_S = 20
WATCH_POLL_S = 5
MONITOR_IDLE_S = 300
WATCH_LEASE_S = 180
ION_EVENTS_MAX = 500
MAX_WATCH_SERIALS = 50
MONITOR_WAIT_S = 25           # a page's request waits up to this long for the next event (answered at once)
# machines (serial watch) is the tenant's whole hardware list: reused this long, so Watch IONs' 5 s checks
# don't double the calls (live: 36 items, 0.15 s). A watched serial's change shows within this.
MACHINES_CACHE_S = 15
# An ION back online has its status (last reboot, the controller's disconnect and reconnect times)
# read REBOOT_CHECK_DELAY_S later, once the controller has recorded the reconnect. A reboot from
# REBOOT_WINDOW before it went offline counts as rebooting during the outage. A reconnect the
# controller never showed as offline (often a power loss) is logged when the ION rebooted or was
# offline at least MISSED_MIN_DOWN_S; shorter ones without a reboot are common and left out (all 1.x).
REBOOT_CHECK_DELAY_S = 20
REBOOT_WINDOW = timedelta(minutes=10)
MISSED_MIN_DOWN_S = 30

# ---- Site details: Top applications --------------------------------------------------------------
# One background job per open site and period: the app list (one or two applicationstats queries),
# then RTT and app unreachable only when their button is pressed, one query per app.
TOP_APPS_CACHE_S = 1800       # a list is rebuilt after this long (RTT and app unreachable carry over)
APPS_ERROR_RETRY_S = 60       # after a failed list, wait this long before trying again
REFRESH_NOW_MIN_S = 60        # "Refresh now": at most once per site and period this often
APP_NAMES_CACHE_S = 6 * 3600  # app id -> name (~4,700 app definitions)
APPS_ELEMENTS_AGE_S = 300      # how old an ION list the list may use to skip sites without IONs
APP_DETAIL_CACHE_S = 600      # Details dialog: one app's response times and destination prefixes
# RTT and app unreachable cover the RTT_TOP_N apps with the most TCP flows plus the TCP apps among
# the first RTT_TOP_DATA by data (the rows shown before "Show all"): about 24 queries each at a small
# site, 37 at a busy one (verified live with 1.x: both take exactly one app per query).
RTT_TOP_N = 20
RTT_TOP_DATA = 25
# Apps the controller never records per-prefix events for (verified live with 1.x on three tenants
# over 7 days), so app unreachable isn't asked for them. Matched by name: app ids differ per tenant.
PREFIX_UNTRACKED_APPS = frozenset({"ssl", "web-browsing", "unknown"})
# RTT trend: the last TXN_RECENT's average against the rest of the period, "up" / "down" when it moved
# by RTT_TREND_MS and RTT_TREND_PCT % or more, with enough minutes of samples on each side.
RTT_TREND_MS, RTT_TREND_PCT = 10, 20
RTT_TREND_MIN_RECENT, RTT_TREND_MIN_BASE = 10, 30
# Failed-transaction rate (Details): every app fails some transactions normally, each at its own
# rate, so the last TXN_RECENT is compared with the rest of the period (the app's normal at the
# site): flagged at TXN_RATIO x normal and TXN_POINTS points above it, with TXN_MIN+ transactions
# in the recent window (with fewer than TXN_BASE_MIN before it, no normal: flagged at TXN_NO_BASE_PCT %+).
TXN_RECENT = timedelta(hours=1)
TXN_MIN, TXN_RATIO, TXN_POINTS = 20, 2, 10
TXN_BASE_MIN, TXN_NO_BASE_PCT = 100, 50

# ---- Site details: probes --------------------------------------------------------------------------
# Fetched only while the Probes section is open: one query per probe config and path (the active
# tunnel of each VPN path, and direct internet), plus the tunnel's own latency per VPN path. Each
# query covers 24 h of 1-minute points (it costs the same as 1 h); the server sums them up for every
# period of the selector (SITE_WINDOWS_H), so changing the period costs no API calls.
PROBE_WINDOW = HISTORY_WINDOW
PROBES_CACHE_S = 290          # a little under the page's 5-minute poll (an entry dates from when its fetch ended)
# The tunnel's latency (LqmLatency per vpnlink) over the period; with none, the newest hour that had
# some in the probe window, marked stale (an idle backup tunnel reports rarely).
PROBE_SLAS_RETRY_S = 60       # a failed performance policy fetch (SLA marks) is tried again this soon
# Round trips per probe test, for the delay beyond the data center: HTTP about 2 (handshake + request), HTTPS 3.
PROBE_ROUND_TRIPS = {"HTTP": 2, "HTTPS": 3}

# ---- Overview: AIOps health and the tenant's applications ----------------------------------------
HEALTH_WINDOW = timedelta(hours=3)    # as SCM
HEALTH_CACHE_S = 290                  # polled every 5 minutes while the Overview is shown
# Health issues' details (asked for when the table is opened): AIOps' 5-minute categories, and for
# each fair or poor link (at most HEALTH_CAUSE_MAX_LINKS, poor first) its quality over the same
# window, two monitor/metrics queries. The cause is the Manager's estimate, not AIOps': in a bad
# interval, loss at or above LINK_LOSS_FLAG_PCT, latency LINK_LATENCY_JUMP_MS or more over the
# link's median, jitter at or above LINK_JITTER_FLAG_MS (and twice its median), or MOS below
# LINK_MOS_FLAG. Fitted to 4 links on a live tenant (105 of 112 intervals, 2026-10-27).
HEALTH_CAUSE_MAX_LINKS = 40
# Fair and poor apps (at most HEALTH_CAUSE_MAX_APPS, poor first): one object_stats call for their
# AIOps score and sites, then per app and fair or poor site (at most HEALTH_APP_SITES) an AppHealth
# aggregate (its counters there) and one monitor/metrics query of its response times and failures.
HEALTH_CAUSE_MAX_APPS = 20
HEALTH_APP_SITES = 3
LINK_LOSS_FLAG_PCT = 0.15
LINK_LATENCY_JUMP_MS = 3.0
LINK_JITTER_FLAG_MS = 5.0
LINK_MOS_FLAG = 4.0
TENANT_APPS_CACHE_S = 600             # every app across the Overview's sites, last 24 h...
TENANT_APPS_WINDOW = timedelta(hours=24)
TENANT_APPS_SITE_CHUNK = 100          # ...sites per applicationstats query (verified live with 1.x: 112 work)
APP_SITES_CACHE_S = 600               # clicking an app: its counts per site (monitor/metrics, 10 sites per query)

# ---- Flow Search -----------------------------------------------------------------------------------
# monitor/flows returns only the hour ending at end_time (whatever start_time says) and no total, so
# a search reads its range as hourly windows split at whole UTC hours, newest first, each paged with
# dest_page until a short page (verified live with 1.x). Throughput is fixed by the API (about two
# pages of 1,000 flows every 8-10 s), so reading less (API-side filters, cached hours) is the only way
# to make a search faster.
FLOW_WINDOW = timedelta(hours=1)
FLOW_PAGE_SIZE = 1000                  # the API's maximum
FLOW_MAX_AGE = timedelta(days=90)           # the oldest supported flow history; older starts are refused
FLOW_MAX_UNFILTERED = timedelta(hours=4)    # longer searches need an app or IP filter
FLOW_MAX_DEST_PORTS = 20
FLOW_SOFT_CAP = 200_000                # a search pauses every this many flows for Keep going / Stop
FLOW_REQUESTS_PER_S = 0.25             # measured with 1.x at 2 in flight, for the time estimate
# Hours that ended at least this long ago are saved once read in full (flows are reported as they
# end, so a recent hour can still grow) and reused by later searches with the same site and filters.
FLOW_CACHE_MIN_AGE = timedelta(hours=1)
FLOW_CACHE_MAX_BYTES = 500 * 1024 * 1024   # data/flowcache.db, compressed (~2M flows); least recently used go first
FLOW_CACHE_MAX_IDLE_S = 7 * 86400          # hours unused this long are dropped
FLOW_JOB_TTL_S = 600                   # a job nobody polled this long is dropped...
FLOW_JOB_ABANDON_S = 180               # ...and a running one stopped after this long (its tab went away)
FLOW_NAMES_CACHE_S = 3600              # policy rule and path names
