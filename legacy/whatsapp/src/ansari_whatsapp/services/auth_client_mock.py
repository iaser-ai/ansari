# Mock apps/auth client
"""Mock client that issues fake tokens without calling apps/auth."""

import uuid

from ansari_whatsapp.services.auth_client_base import AuthClientBase
from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.exceptions import AuthTokenError


class AuthClientMock(AuthClientBase):
    """Gives each BSUID its own stable fake token, so one BSUID is one user and a new BSUID is a new user."""

    async def get_token(self, bsuid: str) -> str:
        if not bsuid:
            raise AuthTokenError("Missing BSUID")
        if get_settings().MOCK_AUTH_TOKEN:
            return get_settings().MOCK_AUTH_TOKEN.get_secret_value()
        return f"mock-token-{uuid.uuid5(uuid.NAMESPACE_URL, f'mock-bsuid:{bsuid}')}"
