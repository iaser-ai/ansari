# Real Meta WhatsApp API service implementation
"""Real client implementation for Meta WhatsApp API via HTTP."""

import json

import httpx
import sentry_sdk

from loguru import logger

from ansari_whatsapp.utils.app_logger import request_id_var
from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.log_masking import mask_identifiers, redact_values
from ansari_whatsapp.services.meta_api_service_base import MetaApiServiceBase


# Why longer timeout? As Meta can take over 5 s (httpx's default) to answer a send-message request from us.
REQUEST_TIMEOUT = httpx.Timeout(20.0, connect=10.0)

# String values of a send payload that describe its shape and name nobody (the rest is masked outside local)
_SAFE_REQUEST_KEYS = {"messaging_product", "type", "recipient_type", "status"}


def _meta_error_summary(response: httpx.Response) -> str:
    """The structured part of Meta's error reply, with anything shaped like an identifier masked.

    Meta documents the error object as `code`, `type`, `error_subcode`, `fbtrace_id`, `message` (the code and its
    title) and `error_data.details`, but not that none of them can name the recipient, so the two texts are masked.
    https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
    """
    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return f"no standard error object ({len(response.content)} bytes)"
    error_data = error.get("error_data") if isinstance(error.get("error_data"), dict) else {}

    def number(value):
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    fields = {
        "code": number(error.get("code")),
        "error_subcode": number(error.get("error_subcode")),
        "type": mask_identifiers(str(error.get("type") or "")[:64]),
        "fbtrace_id": mask_identifiers(str(error.get("fbtrace_id") or "")[:64]),
        "message": mask_identifiers(str(error.get("message") or "")[:300]),
        "details": mask_identifiers(str(error_data.get("details") or "")[:300]),
    }
    return " ".join(f"{name}={value!r}" for name, value in fields.items() if value not in (None, ""))


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

    @staticmethod
    def _log_meta_error(error: httpx.HTTPStatusError) -> None:
        """Log what Meta said, and for a 400 what we sent.

        Meta's raw body is never logged, only its structured fields with identifiers masked. For a 400 the payload's
        keys are logged everywhere; their values too, masked on staging and unmasked only in development.
        """
        logger.error(f"Meta's reply ({error.response.status_code}): {_meta_error_summary(error.response)}")
        if error.response.status_code != 400:
            return
        try:
            sent = json.loads(error.request.content)
        except ValueError:
            logger.error("Meta rejected the request (400); the request body was not JSON")
            return
        if not isinstance(sent, dict):
            logger.error("Meta rejected the request (400); the request body was not a JSON object")
            return

        environment = get_settings().ENVIRONMENT
        line = f"Meta rejected the request (400). URL: {error.request.url} | Payload keys: {sorted(sent)}"
        if environment != "production":
            headers = {k: ("Bearer ***" if k.lower() == "authorization" else v) for k, v in error.request.headers.items()}
            line += f" | Headers: {headers}"
            if environment == "development":
                line += f" | Body: {json.dumps(sent, ensure_ascii=False)}"
            else:
                line += f" | Body with values masked: {redact_values(sent, _SAFE_REQUEST_KEYS)}"
        logger.error(line)

    async def send_typing_indicator(self, recipient_bsuid_or_phone: str, message_id: str) -> None:
        """Send typing indicator via Meta API.

        Args:
            recipient_bsuid_or_phone: Who the typing indicator is for (not sent: Meta ties it to `message_id`)
            message_id: Message ID for the typing indicator

        Raises:
            httpx.HTTPStatusError: If Meta API returns error status
            httpx.RequestError: If network error occurs
        """
        if not recipient_bsuid_or_phone or not message_id:
            logger.error("Cannot send typing indicator: missing recipient_bsuid_or_phone or message_id")
            return

        json_data = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
            "typing_indicator": {"type": "text"},
        }

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
                logger.debug("Sending typing indicator")

                response = await client.post(self.api_url, headers=self._get_headers(), json=json_data)
                response.raise_for_status()
                logger.info("Typing indicator sent successfully")

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error sending typing indicator: {e.response.status_code}")
            self._log_meta_error(e)
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
            logger.error(f"Network error sending typing indicator ({type(e).__name__}): {e}")
            raise
        except Exception as e:
            logger.exception(f"Unexpected error sending typing indicator: {e}")
            raise

    async def send_message(self, recipient_bsuid_or_phone: str, message_parts: list[str]) -> None:
        """Send WhatsApp message(s) via Meta API.

        Args:
            recipient_bsuid_or_phone: A phone number (digits only, sent as `to`) or a business-scoped user ID
                (BSUID, e.g., "US.13491208655302741918", sent as `recipient`)
            message_parts: List of message parts (already split by length)

        Raises:
            httpx.HTTPStatusError: If Meta API returns error status
            httpx.RequestError: If network error occurs

        Note:
            Per Meta, a phone number goes in `to`, while a BSUID goes in `recipient` (with `to` omitted;
            if both are sent, `to` takes precedence). Meta's changelog says BSUID sending is supported
            since July 2026.
            https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids#send-message-requests
        """
        if not recipient_bsuid_or_phone:
            logger.error("Cannot send message: No recipient")
            return

        if not message_parts:
            logger.warning("No message parts to send")
            return

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
                logger.debug(f"Sending {len(message_parts)} message part(s)")

                for i, part in enumerate(message_parts, 1):
                    json_data = {
                        "messaging_product": "whatsapp",
                        "type": "text",
                        "text": {"body": part},
                    }
                    if recipient_bsuid_or_phone.isdigit():
                        json_data["to"] = recipient_bsuid_or_phone
                    else:
                        # Not a phone number, so it's a business-scoped user ID (e.g., US.1349...)
                        json_data["recipient_type"] = "individual"
                        json_data["recipient"] = recipient_bsuid_or_phone

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
            self._log_meta_error(e)
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
            logger.error(f"Network error sending message ({type(e).__name__}): {e}")
            raise
        except Exception as e:
            logger.exception(f"Unexpected error sending message: {e}")
            raise
