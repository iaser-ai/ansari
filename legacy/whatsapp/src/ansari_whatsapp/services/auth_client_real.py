# Real apps/auth client
"""Real client for apps/auth's `/whatsapp` token exchange, over HTTP."""

import time

import httpx
from loguru import logger

from ansari_whatsapp.services.auth_client_base import AuthClientBase
from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.exceptions import (
    AuthBadRequestError,
    AuthKeyRejectedError,
    AuthRateLimitedError,
    AuthTokenError,
    AuthUserBannedError,
)

# Contract (issue #329): POST /api/whatsapp/session with `Authorization: Bearer <key>`, {"bsuid": ...} -> {"token": ...}.
# Errors are {"message"} bodies: 400 the request failed apps/auth's sanity bounds on the BSUID (a bug here), 401 one
# identical body for every key refusal, 403 this user is banned, 429 this user's budget is spent (X-Retry-After),
# 500 an outage or a permanent fault for this one user.
SESSION_PATH = "/api/whatsapp/session"

# The token lives 15 minutes; reuse it for a bit less so a cached one never expires mid-request
TOKEN_CACHE_SECONDS = 14 * 60
TOKEN_CACHE_MAX_ENTRIES = 10_000

# Used when a 429 carries no usable X-Retry-After; apps/auth's per-user window is 15 minutes
DEFAULT_RETRY_AFTER_SECONDS = 60


class AuthClientReal(AuthClientBase):
    """Calls apps/auth over HTTP, authenticated with AUTH_WHATSAPP_API_KEY."""

    def __init__(self):
        settings = get_settings()
        self.url = f"{settings.AUTH_SERVER_URL.rstrip('/')}{SESSION_PATH}"
        self.client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {settings.AUTH_WHATSAPP_API_KEY.get_secret_value()}"},
            timeout=5.0,
        )
        self._cache: dict[str, tuple[str, float]] = {}  # bsuid -> (token, expiry on the monotonic clock)
        self._cooldown: dict[str, float] = {}  # bsuid -> when its 429 ends, on the monotonic clock

    async def close(self) -> None:
        await self.client.aclose()

    async def get_token(self, bsuid: str) -> str:
        now = time.monotonic()
        cached = self._cache.get(bsuid)
        if cached and cached[1] > now:
            return cached[0]

        # A user whose budget is spent is not asked again until it frees up: every ask would only be refused
        until = self._cooldown.get(bsuid)
        if until and until > now:
            raise AuthRateLimitedError("Token exchange refused: user is cooling down", retry_after=int(until - now) + 1)
        self._cooldown.pop(bsuid, None)

        token = await self._exchange(bsuid)
        self._remember(bsuid, token)
        return token

    def forget(self, bsuid: str) -> None:
        """Drop this user's cached token, e.g. after apps/api refused it."""
        self._cache.pop(bsuid, None)

    def _remember(self, bsuid: str, token: str) -> None:
        now = time.monotonic()
        if len(self._cache) >= TOKEN_CACHE_MAX_ENTRIES:
            self._cache = {k: v for k, v in self._cache.items() if v[1] > now}
        if len(self._cache) < TOKEN_CACHE_MAX_ENTRIES:
            self._cache[bsuid] = (token, now + TOKEN_CACHE_SECONDS)

    def _start_cooldown(self, bsuid: str, retry_after: int) -> None:
        now = time.monotonic()
        if len(self._cooldown) >= TOKEN_CACHE_MAX_ENTRIES:
            self._cooldown = {k: v for k, v in self._cooldown.items() if v > now}
        if len(self._cooldown) < TOKEN_CACHE_MAX_ENTRIES:
            self._cooldown[bsuid] = now + retry_after

    @staticmethod
    def _retry_after(response: httpx.Response) -> int:
        try:
            value = int(response.headers.get("X-Retry-After", ""))
        except ValueError:
            return DEFAULT_RETRY_AFTER_SECONDS
        return value if value > 0 else DEFAULT_RETRY_AFTER_SECONDS

    async def _exchange(self, bsuid: str) -> str:
        try:
            response = await self.client.post(self.url, json={"bsuid": bsuid})
        except httpx.RequestError as e:
            logger.error(f"Network error during token exchange: {type(e).__name__}")
            raise AuthTokenError("Network error during token exchange") from e

        status = response.status_code
        if status == 400:
            logger.error("apps/auth refused the request as malformed (HTTP 400): a bug in this service")
            raise AuthBadRequestError("Token exchange failed: HTTP 400")
        if status == 401:
            logger.error("apps/auth rejected this service's API key (HTTP 401): the key needs an operator")
            raise AuthKeyRejectedError("Token exchange failed: HTTP 401")
        if status == 403:
            logger.warning("apps/auth says this user is banned (HTTP 403)")
            raise AuthUserBannedError("Token exchange refused: user is banned")
        if status == 429:
            retry_after = self._retry_after(response)
            self._start_cooldown(bsuid, retry_after)
            logger.warning(f"apps/auth says this user's exchange budget is spent (HTTP 429), retry in {retry_after}s")
            raise AuthRateLimitedError("Token exchange refused: user budget spent", retry_after=retry_after)
        if status != 200:
            logger.error(f"apps/auth failed the token exchange: HTTP {status}")
            raise AuthTokenError(f"Token exchange failed: HTTP {status}")

        try:
            token = response.json().get("token")
        except ValueError as e:
            logger.error("apps/auth returned a non-JSON token response")
            raise AuthTokenError("Invalid token response") from e

        if not isinstance(token, str) or not token:
            logger.error("apps/auth token response had no token")
            raise AuthTokenError("Token response had no token")
        return token
