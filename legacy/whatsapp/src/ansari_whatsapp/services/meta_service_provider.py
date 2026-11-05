# Service Provider for Meta WhatsApp API services
"""Factory function for providing the appropriate Meta API service implementation."""

from loguru import logger

from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.services.meta_api_service_base import MetaApiServiceBase
from ansari_whatsapp.services.meta_api_service_real import MetaApiServiceReal
from ansari_whatsapp.services.meta_api_service_mock import MetaApiServiceMock


def get_meta_api_service() -> MetaApiServiceBase:
    """Factory function that returns the appropriate Meta API service based on configuration.

    This function implements the Service Provider pattern, returning either:
    - MetaApiServiceReal: Makes actual HTTP calls to Meta WhatsApp API (production)
    - MetaApiServiceMock: Simulates API responses without network calls (development/testing)

    The choice is controlled by the MOCK_META_API environment variable.

    Returns:
        MetaApiServiceBase: Either MetaApiServiceReal or MetaApiServiceMock instance

    Example:
        >>> meta_service = get_meta_api_service()
        >>> await meta_service.send_message("+1234567890", ["Hello World"])
    """
    settings = get_settings()

    if settings.MOCK_META_API:
        logger.info("Service Provider: Returning MetaApiServiceMock (mock mode enabled)")
        return MetaApiServiceMock()
    else:
        logger.debug("Service Provider: Returning MetaApiServiceReal (production mode)")
        return MetaApiServiceReal()
