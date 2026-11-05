# WhatsApp Webhook Utilities
"""Utilities for handling webhook operations between Meta and our server.

This module contains functions for:
- Parsing webhook payloads received from Meta
- Verifying webhook signatures for security
- Creating standardized responses for Meta
"""

import hmac
import hashlib
from loguru import logger
from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse, Response

from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.exceptions import UnexpectedMetaPayloadError

settings = get_settings()


async def verify_meta_signature(request: Request) -> None:
    """
    Verify that the webhook request came from Meta using HMAC-SHA256 signature.

    Meta signs all webhook payloads with your app's App Secret and includes the signature
    in the X-Hub-Signature-256 header. This function validates that signature to ensure
    the request is authentic and hasn't been tampered with.

    References:
    - https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
    - https://stackoverflow.com/questions/75422064/validate-x-hub-signature-256-meta-whatsapp-webhook-request

    Args:
        request: FastAPI Request object containing the webhook payload and headers

    Raises:
        HTTPException: 403 Forbidden if signature is invalid or missing

    Note:
        This is used with FastAPI's Depends() to automatically validate all
        webhook requests before processing them, similar to the authentication
        pattern used in ansari-backend.
    """
    # Get raw body bytes (cached after first read)
    body_bytes = await request.body()
    signature_header = request.headers.get("X-Hub-Signature-256", "")

    if not signature_header or not signature_header.startswith("sha256="):
        logger.warning("Missing or invalid X-Hub-Signature-256 header format")
        logger.error("Webhook signature verification failed - rejecting request")
        raise HTTPException(
            status_code=403,
            detail="Invalid signature",
            headers={"WWW-Authenticate": "HMAC-SHA256"},
        )

    # Extract the received signature from the header (remove "sha256=" prefix)
    signature_received_from_meta = signature_header.replace("sha256=", "")

    # Extract our server's signature by
    # computing HMAC-SHA256 using meta's app secret
    app_secret = settings.META_ANSARI_APP_SECRET.get_secret_value().encode("utf-8")
    computed_signature = hmac.new(app_secret, body_bytes, hashlib.sha256).hexdigest()

    # Attempt secret verification by comparing signatures
    # (i.e., if signatures match, then the app secret used to compute both signatures is the same)
    is_valid = hmac.compare_digest(computed_signature, signature_received_from_meta)

    if is_valid:
        logger.debug("Webhook signature verified successfully")
        return
    else:
        # If no match happens, raise exception
        logger.error("Invalid webhook signature; request isn't from Meta or you have misconfigured META_ANSARI_APP_SECRET")
        raise HTTPException(
            status_code=403,
            detail="Invalid signature",
            headers={"WWW-Authenticate": "HMAC-SHA256"},
        )


def create_response_for_meta(
    success: bool = True,
    message: str = "OK",
    status_code: int = 200,
    error_code: str | None = None,
    details: dict | None = None,
) -> Response:
    """
    Create appropriate webhook response based on deployment environment.

    In test environment: Returns proper HTTP status codes for testing
    In production/staging/local: Always returns 200 for Meta compliance

    Args:
        success: Whether the operation was successful
        message: Human-readable message
        status_code: HTTP status code to use (only in test mode)
        error_code: Machine-readable error code
        details: Additional details to include in response as "detail" key

    Returns:
        Response: HTTP response appropriate for current environment

    Notes:
        **Meta Compliance Requirement:**
        WhatsApp requires webhooks to return HTTP 200 status within ~5 seconds to acknowledge receipt.
        If any other status code is returned (or timeout occurs), Meta treats it as a failed delivery and
        retries with increasing delays for up to 24 hours. This can cause duplicate message processing.

        **Official Documentation:**
        - WhatsApp Webhooks Setup Guide:
          https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview#webhook-delivery-failure
        - Webhook Events and Retry Behavior (360dialog):
          https://docs.360dialog.com/docs/waba-basics/webhook-events-and-notifications
    """
    # Create response body with structured information
    response_body = {"success": success, "message": message, "timestamp": int(__import__("time").time())}

    if error_code:
        response_body["error_code"] = error_code

    if details:
        response_body["detail"] = details

    # When ALWAYS_RETURN_OK_TO_META is False: return proper HTTP status codes (for testing)
    # When ALWAYS_RETURN_OK_TO_META is True: always return 200 for Meta compliance
    if not settings.ALWAYS_RETURN_OK_TO_META:
        return JSONResponse(content=response_body, status_code=status_code if not success else 200)

    # Always return 200 for Meta compliance (production behavior)
    # But still include structured response body for logging/debugging
    return JSONResponse(content=response_body, status_code=200)


# Keys whose string values are safe to log as-is (everything else is masked, e.g., phone numbers, names, text)
_UNREDACTED_KEYS = {"object", "field", "messaging_product", "type", "id", "timestamp"}


def _redact_for_logging(obj, key: str | None = None):
    """Return obj with its structure intact but string values masked as `<str len=N>`, except for safe keys
    (i.e., keys in _UNREDACTED_KEYS)."""
    if isinstance(obj, dict):
        return {k: _redact_for_logging(v, k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact_for_logging(v, key) for v in obj]
    if isinstance(obj, str) and key not in _UNREDACTED_KEYS:
        return f"<str len={len(obj)}>"
    return obj


async def parse_meta_payload(
    body: dict[str, dict],
) -> tuple[bool, bool, str | None, str | None, dict | None, str | None, int | None]:
    """
    Parse the webhook payload received from Meta to extract relevant message details.

    Args:
        body (dict[str, dict]): The JSON body of the incoming webhook request from Meta.

    Returns:
        tuple: A tuple of (is_status, is_target_business_number, bsuid,
               incoming_msg_type, incoming_msg_body, message_id, message_unix_time).
               `bsuid` is the sender's business-scoped user ID; the phone number is never used.

    Raises:
        Exception: If the payload structure is invalid or unsupported.
    """
    if not (
        body.get("object")
        and (entry := body.get("entry", []))
        and (changes := entry[0].get("changes", []))
        and (value := changes[0].get("value", {}))
    ):
        error_msg = f"Invalid received payload from WhatsApp user and/or problem with Meta's API:\n{_redact_for_logging(body)}"
        logger.error(error_msg)
        raise Exception(error_msg)

    # Check if this webhook is intended for our WhatsApp business number
    # Metadata should always be present in a valid webhook payload
    if "metadata" not in value:
        error_msg = f"Missing metadata in webhook payload from WhatsApp API:\n{_redact_for_logging(value)}"
        logger.error(error_msg)
        raise Exception(error_msg)

    if "phone_number_id" not in value["metadata"]:
        error_msg = f"Missing phone_number_id in webhook payload metadata:\n{_redact_for_logging(value['metadata'])}"
        logger.error(error_msg)
        raise Exception(error_msg)

    incoming_phone_number_id = value["metadata"]["phone_number_id"]
    configured_phone_number_id = settings.META_BUSINESS_PHONE_NUMBER_ID.get_secret_value()
    is_target_business_number = incoming_phone_number_id == configured_phone_number_id

    if not is_target_business_number:
        return None, is_target_business_number, None, None, None, None, None

    if "statuses" in value:
        # This is a status update (delivered, read, etc.), not a user message
        return True, is_target_business_number, None, None, None, None, None

    is_status = False

    if "messages" not in value:
        error_msg = f"Unsupported message type received from WhatsApp user:\n{_redact_for_logging(body)}"
        logger.error(error_msg)
        raise Exception(error_msg)

    incoming_msg = value["messages"][0]

    try:
        # Extract message details. `from_user_id` (the BSUID) is always present; `from` (the phone number) may
        # be missing, and is deliberately never read.
        message_id = incoming_msg.get("id")
        bsuid = incoming_msg["from_user_id"]
        message_unix_time_str = incoming_msg.get("timestamp")
        message_unix_time = int(message_unix_time_str) if message_unix_time_str is not None else None

        # Meta API note: Meta sends "errors" key when receiving unsupported message types
        # (e.g., video notes, gifs sent from giphy, or polls)
        incoming_msg_type = incoming_msg["type"] if incoming_msg["type"] in incoming_msg.keys() else "errors"
        incoming_msg_body = incoming_msg[incoming_msg_type]
    except KeyError as e:
        logger.error(f"Missing key {e} in messages[0]; redacted webhook value: {_redact_for_logging(value)}")
        contact = (value.get("contacts") or [{}])[0]
        reply_to = incoming_msg.get("from_user_id") or contact.get("user_id")
        raise UnexpectedMetaPayloadError(
            f"Missing key {e} in messages[0]; keys present: {sorted(incoming_msg.keys())}",
            reply_to=reply_to,
        ) from e

    logger.info(f"Received a supported whatsapp message (type: {incoming_msg_type})")

    return (
        is_status,
        is_target_business_number,
        bsuid,
        incoming_msg_type,
        incoming_msg_body,
        message_id,
        message_unix_time,
    )
