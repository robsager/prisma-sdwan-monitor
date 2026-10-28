"""Request pacing: a token bucket, per-endpoint concurrency gates, and request priority.

Two priorities. Interactive work (a page request) goes first; background work (the Overview warmer,
prefetches) can't take the last few tokens or the last slot of a gate, and waits while any
interactive request is waiting.
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

from .. import config

_priority = threading.local()


def is_background() -> bool:
    return getattr(_priority, "background", False)


def set_background(flag: bool = True) -> None:
    _priority.background = flag


@contextmanager
def background():
    """Run the block at background priority (restored afterwards)."""
    was = is_background()
    set_background(True)
    try:
        yield
    finally:
        set_background(was)


def pool(background: bool | None = None, workers: int = config.MAX_WORKERS) -> ThreadPoolExecutor:
    """Thread pool whose workers run at the given priority (default: the caller's)."""
    flag = is_background() if background is None else background
    return ThreadPoolExecutor(max_workers=workers, initializer=set_background, initargs=(flag,))


class RateLimiter:
    """Token bucket: `rate` requests/s with bursts of `burst`; background callers keep `reserve` free."""

    def __init__(self, rate=config.RATE_PER_S, burst=config.RATE_BURST, reserve=config.BG_RESERVE,
                 clock=time.monotonic):
        self.rate, self.burst, self.reserve = rate, burst, reserve
        self.clock = clock
        self.tokens = float(burst)
        self.updated = clock()
        self.cond = threading.Condition()

    def _refill(self):
        now = self.clock()
        self.tokens = min(self.burst, self.tokens + (now - self.updated) * self.rate)
        self.updated = now

    def try_acquire(self, background=False) -> float:
        """Take a token and return 0, or return how long to wait before one is available."""
        floor = self.reserve if background else 0
        with self.cond:
            self._refill()
            if self.tokens - 1 >= floor:
                self.tokens -= 1
                return 0.0
            return (floor + 1 - self.tokens) / self.rate

    def acquire(self, background=False):
        while (wait := self.try_acquire(background)) > 0:
            with self.cond:
                self.cond.wait(timeout=min(max(wait, 0.05), 5))


class FamilyGate:
    """Concurrency cap for one endpoint family, with two priorities and an adaptive limit."""

    def __init__(self, cap, floor=2, clock=time.monotonic):
        self.cap = self.limit = cap
        self.floor = min(floor, cap)
        self.clock = clock
        self.active = 0
        self.fg_waiting = 0
        self.restore_at = 0.0
        self.throttled_at = float("-inf")
        self.cond = threading.Condition()

    def _room(self, background):
        if self.limit < self.cap and self.clock() >= self.restore_at:
            self.limit = self.cap
        if background:
            return not self.fg_waiting and self.active < max(1, self.limit - 1)
        return self.active < self.limit

    def acquire(self, background=False):
        with self.cond:
            if not background:
                self.fg_waiting += 1
            try:
                while not self._room(background):
                    self.cond.wait(timeout=1)
            finally:
                if not background:
                    self.fg_waiting -= 1
            self.active += 1

    def release(self):
        with self.cond:
            self.active -= 1
            self.cond.notify_all()

    @contextmanager
    def slot(self, background=False):
        self.acquire(background)
        try:
            yield
        finally:
            self.release()

    def throttle(self):
        """After a 429: lower the cap by one, not below the floor, until GATE_RELAX_S pass without
        another (one step per burst of 429s)."""
        with self.cond:
            now = self.clock()
            if now - self.throttled_at > 5:
                self.limit = max(self.floor, self.limit - 1)
                self.throttled_at = now
            self.restore_at = now + config.GATE_RELAX_S


def endpoint_family(path: str) -> str:
    """Which concurrency gate a path goes through."""
    if "/monitor/aggregates" in path:
        return "aggregates"
    if "/monitor/aiops" in path:
        return "aiops"
    if "/monitor/metrics/probes" in path:
        return "probes"
    if "/monitor/metrics" in path:
        return "metrics"
    if "/monitor/applicationstats" in path:
        return "appstats"
    if "/monitor/flows" in path:
        return "flows"
    return "other"
