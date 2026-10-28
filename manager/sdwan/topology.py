"""Fabric link names from the tenant's topology (one call for the tenant).

Link alarms (anynetlinks, vpnlinks) carry only ids. POST topology {"type": "anynet"} lists every
link with both ends' site and circuit names (verified live with 1.x, where Flow Search's Path
column uses the same names). An anynet link's VPN links get its name too.
"""
from ..config import V


def fetch(client):
    return client.request("POST", f"/sdwan/{V.TOPOLOGY}/api/topology",
                          json={"type": "anynet", "servicelinks": True, "stub_links": True})


def link_names(resp, site_names=None):
    """{link id: name}: a string, or {"name" (tenant-wide), "by_site": {site name: name from its
    side}}: anynet links, because source and target are in no particular order (a site is the
    target of some of its links), and direct internet and service links of a known site (their
    site comes as a node id only, named from site_names: {site id: name})."""
    site_names = site_names or {}
    names = {}
    # Each named link also carries "parts" for the Tenant panel's table: {kind: vpn | direct |
    # service, link (vpn: the anynet link's path_id, shared by its vpnlinks), ends: [{site, site_id, circuit}, ...] (vpn: both, the source first; others: the
    # site's), far (service: the endpoint)}. A link's quality is queried from its branch end
    # (health.quality_end).
    for link in resp.get("links") or []:
        path_id = link.get("path_id")
        if not path_id:
            continue
        kind = link.get("type")
        if kind == "internet-stub":
            circuit = link.get("target_circuit_name") or link.get("network")
            name = f"Direct Internet ({circuit})" if circuit else "Direct Internet"
        elif kind == "servicelink":
            sep, wan = link.get("sep_name") or "Unknown", link.get("wan_nw_name")
            name = f"{sep} ({wan})" if wan else sep
        if kind in ("internet-stub", "servicelink"):
            site = link.get("source_site_name") or site_names.get(link.get("source_node_id"))
            if site:
                end0 = {"site": site, "site_id": link.get("source_node_id"), "circuit": circuit if kind == "internet-stub" else wan}
                parts = ({"kind": "direct", "ends": [end0]} if kind == "internet-stub"
                         else {"kind": "service", "ends": [end0], "far": sep})
                name = {"name": f"{site} {name}", "by_site": {site: name}, "parts": parts}
        else:
            def end(side):
                return (link.get(f"{side}_site_name") or "Unknown",
                        link.get(f"{side}_circuit_name") or link.get(f"{side}_wan_network"))

            def far(site, circuit):
                return f"{site} ({circuit})" if circuit and circuit != site else site

            (s_site, s_cir), (t_site, t_cir) = end("source"), end("target")
            name = {"name": f"{far(s_site, s_cir)} → {far(t_site, t_cir)}",
                    "by_site": {s_site: f"{s_cir or s_site} → {far(t_site, t_cir)}",
                                t_site: f"{t_cir or t_site} → {far(s_site, s_cir)}"},
                    "parts": {"kind": "vpn", "link": path_id, "ends": [{"site": s_site, "site_id": link.get("source_node_id"), "circuit": s_cir},
                                                      {"site": t_site, "site_id": link.get("target_node_id"), "circuit": t_cir}]}}
            for vpnlink_id in link.get("vpnlinks") or []:
                names[vpnlink_id] = name
        names[path_id] = name
    return names


def tunnels(resp):
    """The Overview's Map: every VPN (anynet) link between two of the tenant's sites, [{id (path_id),
    type, sub_type ("auto", "on-demand"), status ("up", "down", "init": as the controller says), admin_up
    (False: disabled, live mostly to a standby data center), ends: [{site_id, site, circuit}
    x2] (the source first), vpnlinks}]. Direct internet and service links have one site and aren't
    drawn."""
    out = []
    for link in resp.get("links") or []:
        path_id = link.get("path_id")
        if not path_id or link.get("type") in ("internet-stub", "servicelink"):
            continue
        a, b = link.get("source_node_id"), link.get("target_node_id")
        if not a or not b:
            continue
        out.append({
            "id": path_id, "type": link.get("type"), "sub_type": link.get("sub_type"), "status": link.get("status"), "admin_up": link.get("admin_up"),
            "ends": [{"site_id": link.get(f"{side}_node_id"), "site": link.get(f"{side}_site_name"),
                      "circuit": link.get(f"{side}_circuit_name") or link.get(f"{side}_wan_network")}
                     for side in ("source", "target")],
            "vpnlinks": link.get("vpnlinks") or [],
        })
    return out


def name_for(names, link_id, site_name):
    """A link's name from this site's side, or None."""
    n = names.get(link_id)
    return n if n is None or isinstance(n, str) else n["by_site"].get(site_name) or n["name"]


def tenant_parts(names, link_id):
    """A link's parts (see link_names), or None."""
    n = names.get(link_id)
    return None if n is None or isinstance(n, str) else n.get("parts")


def tenant_name(names, link_id):
    """A link's name for the whole tenant (both ends, or the site and its link), or None."""
    n = names.get(link_id)
    return n if n is None or isinstance(n, str) else n["name"]
