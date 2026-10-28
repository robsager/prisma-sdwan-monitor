"""Timestamps and numbers in the API's formats."""
import time
from datetime import datetime, timezone

from .config import STEP_SECONDS


def iso(dt: datetime) -> str:
    """The API's timestamp format: 2026-10-24T12:34:00.000Z."""
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def now_iso() -> str:
    return iso(datetime.now(timezone.utc))


def minute_floor() -> datetime:
    """Start of the current minute (UTC) = end of the last complete minute."""
    return datetime.fromtimestamp(int(time.time()) // STEP_SECONDS * STEP_SECONDS, timezone.utc)


def minute_of(value) -> int:
    """Epoch minute of an API timestamp or a datetime (series are keyed by it)."""
    dt = parse_iso(value) if isinstance(value, str) else value
    return int(dt.timestamp()) // STEP_SECONDS


def minute_iso(minute: int) -> str:
    return iso(datetime.fromtimestamp(minute * STEP_SECONDS, timezone.utc))


def utc_ticks(v):
    """*_on_utc values are 100 ns units since 1970 (verified live); 0 means never. ISO or None."""
    return iso(datetime.fromtimestamp(v / 1e7, timezone.utc)) if isinstance(v, (int, float)) and v > 0 else None


def num(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def pct(value, capacity):
    if value is None or not capacity:
        return None
    return round(value / capacity * 100, 1)
