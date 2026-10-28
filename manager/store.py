"""Saved tenants: <data>/tenants.json, in the same format as the 1.x Manager.

Each tenant: tsg_id, name, client_id, client_secret (protected, see secret_store.py), exclude_dc.
Nothing secret is ever returned to the browser: public() masks the client ID and drops the secret.
"""
import json
import os
import re
import sys
import threading

from . import config, secret_store

TSG_RE = re.compile(r"^\d{5,20}$")
_lock = threading.Lock()


def _path() -> str:
    return os.path.join(config.DATA_DIR, "tenants.json")


def _load() -> dict:
    try:
        with open(_path(), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"tenants": []}


def _save(doc: dict) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    os.replace(tmp, _path())
    if sys.platform != "win32":
        os.chmod(_path(), 0o600)


def _find(doc, tsg_id):
    return next((t for t in doc["tenants"] if t["tsg_id"] == tsg_id), None)


def public(t: dict) -> dict:
    cid = t["client_id"]
    return {
        "tsg_id": t["tsg_id"],
        "name": t["name"],
        "client_id_masked": cid[:6] + "…" + cid[-4:] if len(cid) > 12 else "…",
        "exclude_dc": t.get("exclude_dc", True),
    }


def list_tenants() -> list:
    with _lock:
        return [public(t) for t in _load()["tenants"]]


def get_exclude_dc(tsg_id: str) -> bool:
    """Whether the tenant's Overview leaves out data center (HUB) sites (default True)."""
    with _lock:
        t = _find(_load(), tsg_id)
    return t.get("exclude_dc", True) if t else True


def get_credentials(tsg_id: str):
    """(client_id, client_secret), or None for an unknown tenant. Raises secret_store.SecretMissing."""
    with _lock:
        t = _find(_load(), tsg_id)
    return (t["client_id"], secret_store.unprotect(tsg_id, t["client_secret"])) if t else None


def upsert_tenant(tsg_id: str, name: str, client_id: str, client_secret: str | None, exclude_dc: bool = True) -> dict:
    """Add or update a tenant. A blank secret on update keeps the stored one. Raises ValueError."""
    if not TSG_RE.match(tsg_id):
        raise ValueError("TSG ID must be numeric")
    if not name or not client_id:
        raise ValueError("TSG name and client ID are required")
    with _lock:
        doc = _load()
        t = _find(doc, tsg_id)
        if t is None:
            if not client_secret:
                raise ValueError("The client secret is required for a new tenant")
            t = {"tsg_id": tsg_id}
            doc["tenants"].append(t)
        t["name"] = name
        t["client_id"] = client_id
        if client_secret:
            t["client_secret"] = secret_store.protect(tsg_id, client_secret)
        t["exclude_dc"] = bool(exclude_dc)
        _save(doc)
        return public(t)


def delete_tenant(tsg_id: str) -> bool:
    with _lock:
        doc = _load()
        before = len(doc["tenants"])
        doc["tenants"] = [t for t in doc["tenants"] if t["tsg_id"] != tsg_id]
        if len(doc["tenants"]) == before:
            return False
        _save(doc)
    secret_store.forget(tsg_id)
    return True
