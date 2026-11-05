# Real Meta WhatsApp API service implementation
"""Real client implementation for Meta WhatsApp API via HTTP."""

import httpx
import sentry_sdk

from loguru import logger

from ansari_whatsapp.utils.app_logger import request_id_var
from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.services.meta_api_service_base import MetaApiServiceBase


class MetaApiServiceReal(MetaApiServiceBase):
    """Real Meta WhatsApp API service that makes actual HTTP requests."""

    def __init__(self):
        """Initialize Meta API service with settings."""
        settings = get_settings()
        self.api_url = settings.META_API_URL
        self.access_token = settings.META_ACCESS_TOKEN_FROM_SYS_USER.get_secret_value()

    def _get_headers(self) -> dict:
        """Get HTTP headers for Meta API requests.

        Returns:
            dict: Headers with authorization and content-type
        """
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
        }

    async def send_typing_indicator(self, recipient_phone: str, message_id: str) -> None:
        """Send typing indicator via Meta API.

        Args:
            recipient_phone: WhatsApp phone number of recipient
            message_id: Message ID for the typing indicator

        Raises:
            httpx.HTTPStatusError: If Meta API returns error status
            httpx.RequestError: If network error occurs
        """
        if not recipient_phone or not message_id:
            logger.error("Cannot send typing indicator: missing recipient_phone or message_id")
            return

        json_data = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
            "typing_indicator": {"type": "text"},
        }

        try:
            async with httpx.AsyncClient() as client:
                logger.debug("Sending typing indicator")

                response = await client.post(self.api_url, headers=self._get_headers(), json=json_data)
                response.raise_for_status()
                logger.info("Typing indicator sent successfully")

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error sending typing indicator: {e.response.status_code}")
            # Only capture 5xx errors (Meta's fault, not ours)
            if e.response.status_code >= 500:
                sentry_sdk.set_tag("error_type", "meta_api_failure")
                sentry_sdk.set_context(
                    "meta_api_details",
                    {
                        "status_code": e.response.status_code,
                        "endpoint": "send_typing_indicator",
                        "request_id": request_id_var.get(),
                    },
                )
                sentry_sdk.capture_exception(e)
            raise
        except httpx.RequestError as e:
            logger.error(f"Network error sending typing indicator: {e}")
            raise
        except Exception as e:
            logger.exception(f"Unexpected error sending typing indicator: {e}")
            raise

    async def send_message(self, recipient_phone: str, message_parts: list[str]) -> None:
        """Send WhatsApp message(s) via Meta API.

        Args:
            recipient_phone: WhatsApp phone number of recipient, or a business-scoped user ID (BSUID,
                e.g., "US.13491208655302741918") if the user's phone number is hidden
            message_parts: List of message parts (already split by length)

        Raises:
            httpx.HTTPStatusError: If Meta API returns error status
            httpx.RequestError: If network error occurs

        Note:
            Per Meta, a phone number goes in `to`, while a BSUID goes in `recipient` (with `to` omitted;
            if both are sent, `to` takes precedence). Meta's page marks BSUID sending as "coming soon"
            in one place and as supported from July 2026 in another, and this hasn't been tested against
            the live API.
            https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#send-message-requests
        """
        if not recipient_phone:
            logger.error("Cannot send message: No recipient")
            return

        if not message_parts:
            logger.warning("No message parts to send")
            return

        try:
            async with httpx.AsyncClient() as client:
                logger.debug(f"Sending {len(message_parts)} message part(s)")

                for i, part in enumerate(message_parts, 1):
                    json_data = {
                        "messaging_product": "whatsapp",
                        "text": {"body": part},
                    }
                    if recipient_phone.isdigit():
                        json_data["to"] = recipient_phone
                    else:
                        # Not a phone number, so it's a business-scoped user ID (e.g., US.1349...)
                        json_data["recipient_type"] = "individual"
                        json_data["recipient"] = recipient_phone

                    response = await client.post(self.api_url, headers=self._get_headers(), json=json_data)
                    response.raise_for_status()

                    # Log message part
                    if part != "...":
                        logger.info(f"Sent message part {i}/{len(message_parts)}: {len(part)} characters")
                    else:
                        logger.info("Sent typing indicator")

                logger.info(f"All {len(message_parts)} message part(s) sent successfully")

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error sending message: {e.response.status_code}")
            # Only capture 5xx errors (Meta's fault, not ours)
            if e.response.status_code >= 500:
                sentry_sdk.set_tag("error_type", "meta_api_failure")
                sentry_sdk.set_context(
                    "meta_api_details",
                    {
                        "status_code": e.response.status_code,
                        "endpoint": "send_message",
                        "request_id": request_id_var.get(),
                    },
                )
                sentry_sdk.capture_exception(e)
            raise
        except httpx.RequestError as e:
            logger.error(f"Network error sending message: {e}")
            raise
        except Exception as e:
            logger.exception(f"Unexpected error sending message: {e}")
            raise
