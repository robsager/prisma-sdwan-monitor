"""data/cache.db: what is slow to fetch again after a restart.

circuit_series: one row per circuit, its metrics as minute-indexed arrays, zlib-compressed, and the
end of its last complete fetch, so a site opens at once. snapshots: zlib-compressed JSON results such
as a site's Top applications. Only a cache: deleting the file means the next open fetches from the
API again. data/flowcache.db (FlowCache): Flow Search's past hours.
"""
import json
import os
import sqlite3
import threading
import time
import zlib

from . import config


def encode(series):
    """{key: {minute: value}} -> bytes. Each metric is stored as its first minute and one value per
    minute (None for gaps), about a fifth of the size of time-stamped points."""
    packed = {}
    for key, points in series.items():
        if points:
            first, last = min(points), max(points)
            packed[key] = [first, [points.get(m) for m in range(first, last + 1)]]
    return zlib.compress(json.dumps(packed, separators=(",", ":")).encode(), 6)


def decode(blob):
    out = {}
    for key, (first, values) in json.loads(zlib.decompress(blob)).items():
        out[key] = {first + i: v for i, v in enumerate(values) if v is not None}
    return out


class SeriesDB:
    def __init__(self, path=None):
        self._path = path
        self._lock = threading.Lock()
        self._conn = None

    def _db(self):
        if self._conn is None:
            path = self._path or os.path.join(config.DATA_DIR, "cache.db")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            self._conn = sqlite3.connect(path, check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("DROP TABLE IF EXISTS series")  # 1.x's per-metric series, replaced by circuit_series
            self._conn.execute("""CREATE TABLE IF NOT EXISTS circuit_series (
                tsg TEXT, wid TEXT, fetched_until INTEGER, body BLOB, updated REAL, PRIMARY KEY (tsg, wid))""")
            self._conn.execute("""CREATE TABLE IF NOT EXISTS snapshots (
                tsg TEXT, key TEXT, body BLOB, updated REAL, PRIMARY KEY (tsg, key))""")
            # Rows are replaced, never removed otherwise: sites nobody opens any more, deleted
            # tenants and old periods would stay forever.
            cutoff = time.time() - config.CACHE_MAX_AGE_S
            self._conn.execute("DELETE FROM circuit_series WHERE updated < ?", (cutoff,))
            self._conn.execute("DELETE FROM snapshots WHERE updated < ?", (cutoff,))
            self._conn.commit()
        return self._conn

    def save(self, tsg, rows):
        """rows: {wid: (fetched_until epoch minute or None, {key: {minute: value}})}"""
        now = time.time()
        data = [(tsg, wid, fetched, encode(series), now) for wid, (fetched, series) in rows.items()]
        if not data:
            return
        with self._lock:
            db = self._db()
            db.executemany("INSERT OR REPLACE INTO circuit_series VALUES (?, ?, ?, ?, ?)", data)
            db.commit()

    def load(self, tsg, wids):
        """{wid: (fetched_until, series)} for the circuits that have a row."""
        if not wids:
            return {}
        with self._lock:
            rows = self._db().execute(
                f"SELECT wid, fetched_until, body FROM circuit_series WHERE tsg = ? AND wid IN ({','.join('?' * len(wids))})",
                [tsg, *wids]).fetchall()
        out = {}
        for wid, fetched, body in rows:
            try:
                out[wid] = (fetched, decode(body))
            except (zlib.error, ValueError, TypeError):
                pass  # unreadable row: fetched again
        return out

    def save_snapshot(self, tsg, key, body):
        blob = zlib.compress(json.dumps(body, separators=(",", ":")).encode(), 6)
        with self._lock:
            db = self._db()
            db.execute("INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?)", (tsg, key, blob, time.time()))
            db.commit()

    def load_snapshot(self, tsg, key):
        """(body, saved at epoch seconds), or (None, 0.0) when there's none or it can't be read."""
        with self._lock:
            row = self._db().execute("SELECT body, updated FROM snapshots WHERE tsg = ? AND key = ?", (tsg, key)).fetchone()
        if not row:
            return None, 0.0
        try:
            return json.loads(zlib.decompress(row[0])), row[1]
        except (zlib.error, ValueError, TypeError):
            return None, 0.0

    def close(self):
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None


class FlowCache:
    """data/flowcache.db: Flow Search's fully read past hours, one zlib-compressed row per site, filter
    and hour (key: flow_search.window_key), kept under FLOW_CACHE_MAX_BYTES (least recently used go
    first) and dropped after FLOW_CACHE_MAX_IDLE_S unused. Shared by every tenant (the key has the TSG)."""

    def __init__(self, path=None):
        self._path = path
        self._lock = threading.Lock()
        self._conn = None

    def _db(self):
        if self._conn is None:
            path = self._path or os.path.join(config.DATA_DIR, "flowcache.db")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            self._conn = sqlite3.connect(path, check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("""CREATE TABLE IF NOT EXISTS flow_windows (
                key TEXT PRIMARY KEY, body BLOB, size INTEGER, flows INTEGER, used REAL)""")
        return self._conn

    def load(self, key):
        """The hour's flows, or None if not cached (or unreadable)."""
        with self._lock:
            db = self._db()
            row = db.execute("SELECT body FROM flow_windows WHERE key = ?", (key,)).fetchone()
            if row is None:
                return None
            db.execute("UPDATE flow_windows SET used = ? WHERE key = ?", (time.time(), key))
            db.commit()
        try:
            return json.loads(zlib.decompress(row[0]))
        except (zlib.error, ValueError, TypeError):
            return None

    def save(self, key, flows):
        body = zlib.compress(json.dumps(flows, separators=(",", ":")).encode(), 6)
        now = time.time()
        with self._lock:
            db = self._db()
            db.execute("INSERT OR REPLACE INTO flow_windows VALUES (?, ?, ?, ?, ?)", (key, body, len(body), len(flows), now))
            db.execute("DELETE FROM flow_windows WHERE used < ?", (now - config.FLOW_CACHE_MAX_IDLE_S,))
            excess = (db.execute("SELECT SUM(size) FROM flow_windows").fetchone()[0] or 0) - config.FLOW_CACHE_MAX_BYTES
            if excess > 0:
                drop = []
                for k, size in db.execute("SELECT key, size FROM flow_windows ORDER BY used"):
                    if excess <= 0:
                        break
                    drop.append((k,))
                    excess -= size
                db.executemany("DELETE FROM flow_windows WHERE key = ?", drop)
            db.commit()

    def close(self):
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None
