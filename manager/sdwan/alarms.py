"""Alarms from events/query.

Active ("standing") alarms are nested the way SCM shows them. The controller rolls alarms up under a
site-level summary alarm (SITE_CONNECTIVITY_DOWN / _DEGRADED): the rolled-up ones stay standing and
not cleared, with suppressed=true and suppressed_info.summary_event_ids naming the summary alarm,
whose own info is empty. Listed flat, every down fabric link of a degraded site would read as its
own active alarm, so each goes into its summary alarm's "causes"; one whose summary alarm isn't
standing stays top level. (Verified live with 1.x.)
"""
from datetime import datetime, timezone

from .. import config
from ..config import V
from ..timeutil import iso, parse_iso, utc_ticks


def entity(event):
    """{entity_type, entity_id} from an event's entity_ref (".../<type>/<id>")."""
    parts = (event.get("entity_ref") or "").split("/")
    return {"entity_type": parts[-2] if len(parts) >= 2 else None, "entity_id": parts[-1] if parts else None}


def ref_site(event):
    """The site in an entity_ref like tenants/T/sites/S/elements/E/interfaces/I, or None."""
    parts = (event.get("entity_ref") or "").split("/")
    return parts[parts.index("sites") + 1] if "sites" in parts[:-1] else None


def query_pages(client, body):
    """(events, truncated): events/query newest first, 100 per page via _offset, at most
    MAX_ALARM_PAGES pages; truncated when pages were left."""
    body = {"limit": {"count": 100, "sort_on": "time", "sort_order": "descending"},
            "view": {"summary": False}, "severity": [], **body}
    out, offset = [], None
    for _ in range(config.MAX_ALARM_PAGES):
        page = {**body, **({"_offset": offset} if offset else {})}
        resp = client.request("POST", f"/sdwan/{V.EVENTS}/api/events/query", json=page)
        items = resp.get("items") or []
        out += items
        offset = resp.get("_offset")
        if not offset or not items:
            return out, False
    return out, True


def summarize(event):
    """The fields the pages use, plus the summary alarm ids it's rolled up under."""
    summary_ids = (event.get("suppressed_info") or {}).get("summary_event_ids") if event.get("suppressed") else None
    return {
        "id": event.get("id"), "code": event.get("code"), "severity": event.get("severity"),
        "priority": event.get("priority"), "time": event.get("time"),
        "site_id": event.get("site_id") or ref_site(event),
        "element_id": event.get("element_id"), "acknowledged": bool(event.get("acknowledged")),
        **entity(event),
        "info": event.get("info") if isinstance(event.get("info"), dict) else None,
        "summary_ids": summary_ids or [],
    }


def nest(alarms):
    """Move rolled-up alarms into their standing summary alarm's "causes"."""
    by_id = {a["id"]: a for a in alarms if not a["summary_ids"]}
    top = []
    for a in alarms:
        parent = next((by_id[i] for i in a.pop("summary_ids") if i in by_id), None)
        if parent:
            parent.setdefault("causes", []).append(a)
        else:
            top.append(a)
    return top


def place(alarms, elements):
    """The alarms, those without a site_id given their ION's site (live, 1-2% of alarms have none:
    e.g. a process stopped on an ION). An alarm on something not at a site (a User-ID agent) keeps
    None. Copies: the standing alarms are cached and shared."""
    site_of = {e["id"]: e.get("site_id") for e in elements}
    return [a if a.get("site_id") else {**a, "site_id": site_of.get(a.get("element_id"))} for a in alarms]


def standing_alarms(client):
    """Every active alarm in the tenant, nested."""
    items, _ = query_pages(client, {"query": {"type": ["alarm"]}, "temporal_scope": "standing_only"})
    return nest([summarize(e) for e in items])


# ---- cleared alarms (history) ------------------------------------------------------------------
#
# Verified live with 1.x: events/query with start_time / end_time and query.site returns the site's
# alarms that are no longer active (standing ones are left out). An alarm is two records sharing
# correlation_id: the raise (cleared=false) and the clear (cleared=true, its time = when it
# cleared; there is no cleared_time). Some raises have no clear record; their _updated_on_utc is
# set when they stop (on paired ones a median 18 s and at most ~12 min after the clear), so it
# bounds the clear time. A clear without its raise was raised before the window. Flapping alarms
# carry flap_event_details.flap_count.

def _seconds(a, b):
    try:
        return max(0, round((parse_iso(b) - parse_iso(a)).total_seconds()))
    except (TypeError, ValueError):
        return None


def _when(v):
    """_updated_on_utc as ISO: 1.x read it as an ISO time on events; elements carry 100 ns ticks
    under the same name, so take either."""
    return utc_ticks(v) if isinstance(v, (int, float)) else v or None


def at_site(event, site_id, element_ids):
    """The event is the site's: its site_id, else (none set) its entity_ref or its ION."""
    if event.get("site_id"):
        return event["site_id"] == site_id
    return ref_site(event) == site_id or event.get("element_id") in element_ids


def occurrences(records):
    """One entry per alarm (raise and clear paired by correlation_id), newest first."""
    pairs = {}
    for e in records:
        pairs.setdefault(e.get("correlation_id") or e.get("id"), {})["clear" if e.get("cleared") else "raise"] = e
    out = []
    for p in pairs.values():
        e = p.get("raise") or p["clear"]
        raised = p["raise"].get("time") if "raise" in p else None
        cleared = p["clear"].get("time") if "clear" in p else None
        updated = _when(p["raise"].get("_updated_on_utc")) if "raise" in p else None
        end = cleared or updated
        out.append({
            "code": e.get("code"), "severity": e.get("severity"), "priority": e.get("priority"),
            "element_id": e.get("element_id"), **entity(e),
            "info": e.get("info") if isinstance(e.get("info"), dict) else None,
            "raised": raised,            # None: raised before the window
            "cleared": cleared,          # None: the controller sent no clear record...
            "updated": updated if not cleared else None,  # ...it had stopped by this time
            "active_s": _seconds(raised, end) if raised and end else None,
            "suppressed": bool(e.get("suppressed")),
            "flaps": (e.get("flap_event_details") or {}).get("flap_count") or 0,
        })
    out.sort(key=lambda o: _sort_time(o["cleared"] or o["updated"] or o["raised"]), reverse=True)
    return out


def _sort_time(t):
    """Event times come with and without fractions (live), so compare them as datetimes."""
    try:
        return parse_iso(t)
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def history_rows(occs):
    """Occurrences grouped by alarm and affected object, newest first: each row has the count,
    the total time active (of the occurrences with known times), flaps and the occurrences."""
    rows = {}
    for o in occs:
        key = (o["code"], o["element_id"], o["entity_type"], o["entity_id"])
        row = rows.get(key)
        if row is None:
            row = rows[key] = {k: o[k] for k in ("code", "severity", "priority", "element_id", "entity_type", "entity_id", "info")}
            row.update(last=o["cleared"] or o["updated"], last_bound=not o["cleared"], count=0, known=0,
                       active_s=0, flaps=0, occurrences=[])
        row["count"] += 1
        row["flaps"] += o["flaps"]
        if o["active_s"] is not None:
            row["known"] += 1
            row["active_s"] += o["active_s"]
        row["occurrences"].append({k: o[k] for k in ("raised", "cleared", "updated", "active_s", "suppressed", "flaps")})
    return list(rows.values())


def history(client, site_id, element_ids, end=None):
    """The site's alarms cleared in the last 24 h: {start, end, count, rows, truncated}."""
    end = end or datetime.now(timezone.utc)
    start = end - config.HISTORY_WINDOW
    items, truncated = query_pages(client, {"query": {"type": ["alarm"], "site": [site_id]},
                                            "start_time": iso(start), "end_time": iso(end)})
    occs = occurrences([e for e in items if at_site(e, site_id, element_ids)])
    return {"start": iso(start), "end": iso(end), "count": len(occs), "rows": history_rows(occs), "truncated": truncated}
