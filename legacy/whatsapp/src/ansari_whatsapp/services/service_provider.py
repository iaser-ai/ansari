# Service Provider for ansari-whatsapp
"""Factory functions for providing the apps/api and apps/auth client implementations."""

from typing import Optional
from loguru import logger

from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.services.ansari_client_base import AnsariClientBase
from ansari_whatsapp.services.ansari_client_real import AnsariClientReal
from ansari_whatsapp.services.ansari_client_mock import AnsariClientMock
from ansari_whatsapp.services.auth_client_base import AuthClientBase
from ansari_whatsapp.services.auth_client_real import AuthClientReal
from ansari_whatsapp.services.auth_client_mock import AuthClientMock


# Singleton instances - shared across the entire application
_ansari_client_instance: Optional[AnsariClientBase] = None
_auth_client_instance: Optional[AuthClientBase] = None


def get_ansari_client() -> AnsariClientBase:
    """Return THE SAME apps/api client instance (singleton).

    A singleton keeps one connection pool and gives tests and the mock a consistent state.
    The choice between the real and mock client is controlled by MOCK_ANSARI_CLIENT and
    evaluated only on first call.

    Note:
        For test isolation, use reset_ansari_client() to clear the singleton between tests.
    """
    global _ansari_client_instance

    if _ansari_client_instance is None:
        if get_settings().MOCK_ANSARI_CLIENT:
            logger.info("Service Provider: Creating AnsariClientMock singleton")
            _ansari_client_instance = AnsariClientMock()
        else:
            logger.debug("Service Provider: Creating AnsariClientReal singleton")
            _ansari_client_instance = AnsariClientReal()

    return _ansari_client_instance


def get_auth_client() -> AuthClientBase:
    """Return THE SAME apps/auth client instance (singleton).

    The choice between the real and mock client is controlled by MOCK_AUTH_CLIENT and
    evaluated only on first call. Use reset_auth_client() for test isolation.
    """
    global _auth_client_instance

    if _auth_client_instance is None:
        if get_settings().MOCK_AUTH_CLIENT:
            logger.info("Service Provider: Creating AuthClientMock singleton")
            _auth_client_instance = AuthClientMock()
        else:
            logger.debug("Service Provider: Creating AuthClientReal singleton")
            _auth_client_instance = AuthClientReal()

    return _auth_client_instance


def reset_ansari_client() -> None:
    """Reset the apps/api client singleton (for test fixtures only; not for production code)."""
    global _ansari_client_instance
    _ansari_client_instance = None
    logger.debug("Service Provider: Ansari client singleton reset")


def reset_auth_client() -> None:
    """Reset the apps/auth client singleton (for test fixtures only; not for production code)."""
    global _auth_client_instance
    _auth_client_instance = None
    logger.debug("Service Provider: Auth client singleton reset")
