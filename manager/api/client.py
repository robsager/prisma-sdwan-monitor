"""Prisma SASE API client for one tenant (TSG).

Handles what the SASE API requires:
  * OAuth2 client-credentials token scoped to the TSG (15-minute lifetime), refreshed a minute early
    or once on a 401
  * GET /sdwan/v2.1/api/profile after every new token (otherwise SD-WAN calls return 403)
  * X-PANW-Region on /sdwan/monitor/ calls: the tenant's x_panw_region, else its telemetry_region mapped
  * Pacing (rate limit + per-endpoint concurrency) and retries on 429 / 5xx, honoring Retry-After;
    a 429 pauses that endpoint family for every caller and lowers its concurrency for a while
"""
import random
import threading
import time

import requests

from .. import config
from ..config import V
from .pacing import FamilyGate, RateLimiter, endpoint_family, is_background

RETRY_STATUS = (429, 502, 503, 504)


class ApiError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def error_text(resp) -> str:
    """The useful part of an error response: the API's _error codes and messages if present."""
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:300]
    errs = body.get("_error") or body.get("error") if isinstance(body, dict) else None
    if isinstance(errs, list) and errs:
        return "; ".join(f"{e.get('code', '')} {e.get('message', '')}".strip() for e in errs if isinstance(e, dict))
    if isinstance(body, dict):
        return str(body.get("error_description") or errs or body)[:300]
    return str(body)[:300]


def backoff(attempt: int) -> float:
    """Capped exponential backoff with jitter, so parallel workers don't retry in lockstep."""
    return min(20.0, 1.5 * 2 ** attempt) * random.uniform(0.7, 1.3)


class ApiClient:
    def __init__(self, tsg_id, client_id, client_secret, auth_url=None, api_base=None, sleep=time.sleep):
        self.tsg_id = tsg_id
        self._client_id = client_id
        self._client_secret = client_secret
        self._auth_url = auth_url or config.AUTH_URL
        self._api_base = (api_base or config.API_BASE).rstrip("/")
        self._sleep = sleep
        self._session = requests.Session()
        self._token = None
        self._token_exp = 0.0
        self._auth_lock = threading.Lock()
        self.tenant_name = None
        self.region = None
        self._limiter = RateLimiter()
        self._gates = {family: FamilyGate(cap, config.GATE_MIN.get(family, 2))
                       for family, cap in config.ENDPOINT_CONCURRENCY.items()}
        self._cooldowns = {}  # endpoint family -> monotonic time until which it pauses (after a 429)
        self._cooldown_lock = threading.Lock()

    # ---- auth -------------------------------------------------------------------------------------

    def ensure_token(self, force=False, stale=None):
        """Get a token if there's none or it expires within a minute (force: always). stale = the
        token a request just got a 401 with: if another thread already replaced it, do nothing, so
        concurrent 401s cost one new token, not one each."""
        with self._auth_lock:
            if force and stale is not None and self._token != stale:
                return
            if not force and self._token and time.time() < self._token_exp - 60:
                return
            try:
                resp = self._session.post(
                    self._auth_url, auth=(self._client_id, self._client_secret), timeout=30,
                    data={"grant_type": "client_credentials", "scope": f"tsg_id:{self.tsg_id}"})
            except requests.RequestException as e:  # offline, DNS, proxy: an error the page can show, not a 500
                raise ApiError(f"Authentication failed: {e}") from e
            if resp.status_code != 200:
                raise ApiError(f"Authentication failed ({resp.status_code}): {error_text(resp)}", resp.status_code)
            body = resp.json()
            self._token = body["access_token"]
            self._token_exp = time.time() + int(body.get("expires_in", 900))

            # Until the profile call succeeds the token gets 403 on every SD-WAN call, so a failed one
            # (even a network error) drops the token and the next request signs in again.
            try:
                profile = self._send("GET", f"/sdwan/{V.PROFILE}/api/profile")
            except requests.RequestException as e:
                self._token = None
                raise ApiError(f"Profile call failed: {e}") from e
            if profile.status_code != 200:
                self._token = None
                raise ApiError(f"Profile call failed ({profile.status_code}): {error_text(profile)}", profile.status_code)
            if self.region is None:
                self._load_tenant()

    def _load_tenant(self):
        tenant = self._send("GET", f"/sdwan/{V.TENANT}/api")
        if tenant.status_code == 200:
            t = tenant.json()
            self.tenant_name = t.get("name")
            region = t.get("telemetry_region") or "us"
            self.region = t.get("x_panw_region") or config.REGION_MAP.get(region, region)
        else:
            self.region = "americas"

    def test(self):
        """Sign in from scratch; returns what the Tenants dialog shows."""
        self.ensure_token(force=True)
        return {"tenant_name": self.tenant_name, "region": self.region}

    # ---- requests ---------------------------------------------------------------------------------

    def _send(self, method, path, json=None, token=None):
        headers = {"Authorization": f"Bearer {token or self._token}", "Accept": "application/json"}
        if path.startswith("/sdwan/monitor/") and self.region:
            headers["X-PANW-Region"] = self.region
        return self._session.request(method, self._api_base + path, headers=headers, json=json,
                                     timeout=config.REQUEST_TIMEOUT_S)

    def _wait_cooldown(self, family):
        while True:
            with self._cooldown_lock:
                wait = self._cooldowns.get(family, 0) - time.monotonic()
            if wait <= 0:
                return
            self._sleep(min(wait, 5))

    def _cool_down(self, family, seconds):
        with self._cooldown_lock:
            self._cooldowns[family] = max(self._cooldowns.get(family, 0), time.monotonic() + seconds)

    def request(self, method, path, json=None):
        """One API call -> parsed JSON ({} for an empty body). Raises ApiError."""
        self.ensure_token()
        family = endpoint_family(path)
        gate = self._gates[family]
        bg = is_background()
        reauthed = False
        last = config.MAX_ATTEMPTS - 1
        for attempt in range(config.MAX_ATTEMPTS):
            self._wait_cooldown(family)
            self._limiter.acquire(background=bg)
            token = self._token  # sent with this attempt; on a 401 refresh only if still current
            try:
                with gate.slot(bg):
                    resp = self._send(method, path, json, token)
            except requests.RequestException as e:
                if attempt == last:
                    raise ApiError(f"{method} {path}: {e}") from e
                self._sleep(backoff(attempt))
                continue
            if resp.status_code == 401 and not reauthed:
                self.ensure_token(force=True, stale=token)
                reauthed = True
                continue
            if resp.status_code in RETRY_STATUS and attempt < last:
                retry_after = resp.headers.get("Retry-After", "")
                wait = float(retry_after) if retry_after.isdigit() else backoff(attempt)
                if resp.status_code == 429:
                    gate.throttle()
                    self._cool_down(family, wait)
                else:
                    self._sleep(wait)
                continue
            if resp.status_code >= 400:
                raise ApiError(f"{method} {path} -> {resp.status_code}: {error_text(resp)}", resp.status_code)
            return resp.json() if resp.content else {}
        raise ApiError(f"{method} {path}: retries exhausted")

    def get_items(self, path):
        """A GET collection's items."""
        return self.request("GET", path).get("items") or []

    def close(self):
        self._session.close()
