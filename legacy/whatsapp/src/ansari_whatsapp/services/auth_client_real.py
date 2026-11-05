# Real apps/auth client
"""Real client for apps/auth's `/whatsapp` token exchange, over HTTP."""

import time

import httpx
from loguru import logger

from ansari_whatsapp.services.auth_client_base import AuthClientBase
from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.exceptions import AuthTokenError

# Contract (issue #329): POST /api/whatsapp/session with `Authorization: Bearer <key>`, {"bsuid": ...} -> {"token": ...}.
# Errors are {"message"} bodies: 400 malformed BSUID, 401 any key failure, 500 otherwise.
SESSION_PATH = "/api/whatsapp/session"

# The token lives 15 minutes; reuse it for a bit less so a cached one never expires mid-request
TOKEN_CACHE_SECONDS = 14 * 60
TOKEN_CACHE_MAX_ENTRIES = 10_000


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

    async def close(self) -> None:
        await self.client.aclose()

    async def get_token(self, bsuid: str) -> str:
        cached = self._cache.get(bsuid)
        if cached and cached[1] > time.monotonic():
            return cached[0]
        token = await self._exchange(bsuid)
        self._remember(bsuid, token)
        return token

    def _remember(self, bsuid: str, token: str) -> None:
        now = time.monotonic()
        if len(self._cache) >= TOKEN_CACHE_MAX_ENTRIES:
            self._cache = {k: v for k, v in self._cache.items() if v[1] > now}
        if len(self._cache) < TOKEN_CACHE_MAX_ENTRIES:
            self._cache[bsuid] = (token, now + TOKEN_CACHE_SECONDS)

    async def _exchange(self, bsuid: str) -> str:
        try:
            response = await self.client.post(self.url, json={"bsuid": bsuid})
            response.raise_for_status()
            token = response.json().get("token")
        except httpx.HTTPStatusError as e:
            logger.error(f"apps/auth rejected the token exchange: HTTP {e.response.status_code}")
            raise AuthTokenError(f"Token exchange failed: HTTP {e.response.status_code}") from e
        except httpx.RequestError as e:
            logger.error(f"Network error during token exchange: {type(e).__name__}")
            raise AuthTokenError("Network error during token exchange") from e
        except ValueError as e:
            logger.error("apps/auth returned a non-JSON token response")
            raise AuthTokenError("Invalid token response") from e

        if not isinstance(token, str) or not token:
            logger.error("apps/auth token response had no token")
            raise AuthTokenError("Token response had no token")
        return token
