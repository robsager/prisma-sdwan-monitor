"""Single-flight TTL cache: one fetch per key at a time; concurrent callers wait for its result.

Every browser tab reads the same results, so N tabs polling the Overview cost one build, not N.
"""
import threading
import time


class CacheError(Exception):
    """A fetch another caller was waiting on failed."""


class SingleFlightCache:
    def __init__(self, clock=time.time, wait_timeout=300):
        self._clock = clock
        self._wait_timeout = wait_timeout
        self._lock = threading.Lock()
        self._entries = {}  # key -> {"value", "at", "event", "error"}

    def get(self, key, ttl, fetch, force=False):
        """The cached value for key if younger than ttl seconds, else fetch() it (once, even when
        called concurrently). force: fetch even if fresh. A failed fetch raises in every waiter
        and leaves the previous value in place for later callers within its ttl."""
        with self._lock:
            entry = self._entries.setdefault(key, {"value": None, "at": 0.0, "event": None, "error": None})
            if not force and entry["value"] is not None and self._clock() - entry["at"] < ttl:
                return entry["value"]
            leader = entry["event"] is None
            if leader:
                entry["event"] = threading.Event()
            event = entry["event"]
        if not leader:
            event.wait(timeout=self._wait_timeout)
            with self._lock:
                if entry["error"] is None and entry["value"] is not None:
                    return entry["value"]
                raise CacheError(entry["error"] or "refresh timed out")
        try:
            value = fetch()
        except Exception as e:
            with self._lock:
                entry["error"] = str(e)
            raise
        else:
            with self._lock:
                entry.update(value=value, at=self._clock(), error=None)
            return value
        finally:
            with self._lock:
                entry["event"] = None
            event.set()

    def discard(self, key):
        """Forget key unless a fetch for it is running."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None and entry["event"] is None:
                del self._entries[key]

    def peek(self, key):
        """The cached value regardless of age, or None."""
        with self._lock:
            entry = self._entries.get(key)
            return entry["value"] if entry else None
