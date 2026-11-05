# Main WhatsApp API application
"""
FastAPI application for handling WhatsApp webhook requests.

This application serves as a wrapper around the Ansari backend API,
handling incoming webhook requests from the WhatsApp Business API
and forwarding them to the Ansari backend for processing.

NOTE: the `BackgroundTasks` logic is inspired by this issue and chat (respectively):
https://stackoverflow.com/questions/72894209/whatsapp-cloud-api-sending-old-message-inbound-notification-multiple-time-on-my
https://www.perplexity.ai/search/explain-fastapi-s-backgroundta-rnpU7D19QpSxp2ZOBzNUyg
"""

import hmac
import uuid

from fastapi import FastAPI, HTTPException, Request, BackgroundTasks, Depends
from fastapi.responses import HTMLResponse, Response, JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import sentry_sdk
from sentry_sdk.types import Event, Hint

from ansari_whatsapp.services.whatsapp_conversation_manager import WhatsAppConversationManager
from ansari_whatsapp.utils.whatsapp_webhook_utils import (
    parse_meta_payload,
    verify_meta_signature,
    create_response_for_meta,
)

# Note: Importing app_logger automatically configures loguru's logger due to module-level execution
from ansari_whatsapp.utils.app_logger import logger, request_id_var
from ansari_whatsapp.utils.time_utils import is_message_too_old
from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.exceptions import UnexpectedMetaPayloadError
from ansari_whatsapp.utils.general_helpers import CORSMiddlewareWithLogging


# Configure Sentry for error tracking when we're NOT developing locally
# NOTE: The SENTRY_DSN check is redundant, since Sentry's init() and other methods
#   will be in "no-ops" mode (i.e., do nothing) if the DSN isn't configured.
#   Source: https://docs.sentry.io/platforms/python/configuration/options/#dsn
#   Nevertheless, we're adding it here for clarity.
deployment_type = get_settings().DEPLOYMENT_TYPE
if get_settings().SENTRY_DSN and deployment_type != "local":
    ignore_errors = [
        "HTTP exception: 401",
        "HTTP exception: 403",
    ]

    def sentry_before_send(event: Event, hint: Hint) -> Event | None:
        logentry = event.get("logentry")
        if logentry and any(error in logentry.get("message", "") for error in ignore_errors):
            return None

        return event

    sentry_sdk.init(
        dsn=get_settings().SENTRY_DSN,
        environment=deployment_type,
        # Add data like request headers and IP for users, if applicable;
        # see https://docs.sentry.io/platforms/python/data-management/data-collected/ for more info
        send_default_pii=False,
        # Set traces_sample_rate to 1.0 to capture 100%
        # of transactions for tracing.
        traces_sample_rate=0.2 if deployment_type == "production" else 1.0,
        # Set profiles_sample_rate to 1.0 to profile 100%
        # of sampled transactions.
        # We recommend adjusting this value in production.
        profiles_sample_rate=0.2 if deployment_type == "production" else 1.0,
        before_send=sentry_before_send,
    )


# Create FastAPI application
app = FastAPI(
    title="Ansari WhatsApp API",
    description="API for handling WhatsApp webhook requests for the Ansari service",
    version="1.0.0",
)


# Custom exception handlers for consistent error responses
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request, exc):
    logger.error(f"HTTP exception: {exc}")
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    errors = exc.errors()
    logger.error(f"Validation errors: {errors}")
    return JSONResponse(
        status_code=400,
        content={"detail": str(exc)},
    )


@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    logger.error(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


async def trigger_error():
    1 / 0  # deliberate error to test Sentry


# This open endpoint crashes on purpose, so it is only registered outside production
if get_settings().DEPLOYMENT_TYPE != "production":
    app.get("/sentry-debug")(trigger_error)


# Add CORS middleware with logging
app.add_middleware(
    CORSMiddlewareWithLogging,
    allow_origins=get_settings().ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request ID middleware for log correlation
@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """Generate unique request ID for each HTTP request.

    This middleware:
    - Generates a UUID for each incoming request
    - Sets it in a contextvar (accessible in all logs during this request)
    - Adds X-Request-ID header to response for client-side correlation
    """
    request_id = str(uuid.uuid4())
    request_id_var.set(request_id)

    logger.debug("Request started")

    response = await call_next(request)

    response.headers["X-Request-ID"] = request_id
    logger.debug("Request ended")
    return response


@app.get("/")
async def root():
    """Root endpoint for health checks."""
    logger.info("Health check endpoint called")
    return {"status": "ok", "message": "Ansari WhatsApp service is running"}


@app.get("/whatsapp/v2")
async def verification_webhook(request: Request) -> HTMLResponse:
    """
    Handles the WhatsApp webhook verification request.

    Args:
        request (Request): The incoming HTTP request.

    Returns:
        Optional[str]: The challenge string if verification is successful, otherwise raises an HTTPException.

    References:
        - https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
    """
    mode = request.query_params.get("hub.mode")
    verify_token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")

    logger.debug(f"Verification webhook received: {mode=}, {challenge=}, token_present={bool(verify_token)}")

    if mode and verify_token:
        expected_token = get_settings().META_WEBHOOK_VERIFY_TOKEN.get_secret_value()
        if mode == "subscribe" and hmac.compare_digest(verify_token.encode("utf-8"), expected_token.encode("utf-8")):
            logger.info("WHATSAPP WEBHOOK VERIFIED SUCCESSFULLY!")
            # Note: Challenge must be wrapped in an HTMLResponse for Meta to accept and verify the callback
            return HTMLResponse(challenge)
        logger.error("Verification failed: Invalid token or mode")
        raise HTTPException(status_code=403, detail="Forbidden")
    raise HTTPException(status_code=400, detail="Bad Request")


@app.post("/whatsapp/v2")
async def main_webhook(
    request: Request, background_tasks: BackgroundTasks, _: None = Depends(verify_meta_signature)
) -> Response:
    """
    Handles the incoming WhatsApp webhook message from Meta's WhatsApp Business API.

    This is the main webhook endpoint that processes all incoming messages from WhatsApp users.
    It performs several validation and filtering steps before processing user messages:

    **Processing Flow:**
    1. **Verify Signature**: Validates X-Hub-Signature-256 header to ensure request is from Meta
    2. **Extract Message Details**: Parses the webhook payload to extract relevant information
       (sender BSUID, message type, message body, timestamps, etc.)

    3. **Validation Checks** (returns early if conditions met):
       - Verifies the webhook is for our WhatsApp business number
       - Filters out status messages (delivered, read, etc.)
       - Checks if service is under maintenance
       - Handles staging/local development routing (temporary workaround)
       - Validates message age (rejects messages older than configured threshold)
       - Filters unsupported message types (non-text messages)

    4. **Background Processing**:
       - Signs the user in through apps/auth (a failure is reported to the user as a message)
       - Starts typing indicator loop (shows user that bot is processing)
       - Processes text messages asynchronously via background tasks

    **Early Return Scenarios:**
    - Wrong business number: Returns 200 with skip message
    - Status message: Returns 200 with status acknowledgment
    - Maintenance mode: Sends maintenance message and returns 200
    - Staging filter: Returns 200 if message prefixed with "!d" in staging
    - Old message: Ignored (nothing is sent to the user)
    - Unsupported media: Sends unsupported message and returns 200

    **Meta Webhook Compliance:**
    - Must respond quickly (within 20 seconds) to avoid retries
    - Returns 200 status code for successful receipt (actual processing happens in background)
    - All actual message processing is delegated to background tasks

    Args:
        request (Request): The incoming HTTP request containing the webhook payload from Meta.
        background_tasks (BackgroundTasks): FastAPI's background task manager for async processing.

    Returns:
        Response: HTTP response, typically with status code 200 to acknowledge receipt to Meta.
                 Response structure depends on ALWAYS_RETURN_OK_TO_META setting.

    Raises:
        None: All exceptions are caught and handled, returning appropriate responses.
              Errors are logged but don't prevent Meta from receiving a 200 response.

    Note:
        - The function uses FastAPI's BackgroundTasks to process messages asynchronously,
          ensuring quick responses to Meta while handling potentially long-running operations.
        - The staging "!d" prefix filter is a temporary workaround until dedicated test numbers
          are available for each environment.
    """
    # Step 1: Signature verification now handled by Depends(verify_meta_signature_dependency)
    # Step 2 and 3: Parse the JSON payload and extract message details from it
    try:
        data = await request.json()
        (
            is_status,
            is_target_business_number,
            bsuid,
            incoming_msg_type,
            incoming_msg_body,
            message_id,
            message_unix_time,
        ) = await parse_meta_payload(data)

        # Check if this webhook is intended for our WhatsApp business phone number
        if not is_target_business_number:
            logger.debug("Ignoring webhook not intended for our WhatsApp business number")
            return create_response_for_meta(
                success=True,
                message="Skipping, as this webhook is not intended for our WhatsApp business number",
                status_code=200,
            )

        # Terminate if the incoming message is a status message (e.g., "delivered")
        if is_status:
            logger.debug("Ignoring status update message (e.g., delivered, read)")
            # This is a status message, not a user message, so doesn't need processing
            return create_response_for_meta(
                success=True, message="Status message processed (ignored)", error_code="STATUS_MESSAGE"
            )

        logger.debug("Incoming whatsapp webhook message")
    except UnexpectedMetaPayloadError as e:
        logger.error(f"Unexpected Meta payload format: {e}")
        sentry_sdk.set_tag("error_type", "unexpected_meta_payload")
        sentry_sdk.set_context(
            "webhook_details",
            {
                "request_id": request_id_var.get(),
            },
        )
        sentry_sdk.capture_exception(e)
        if e.reply_to:
            notifier = WhatsAppConversationManager(bsuid=e.reply_to)
            background_tasks.add_task(
                notifier.send_whatsapp_message,
                "It seems Meta sent your message in an unexpected format. This is not a problem in what you wrote, "
                "so please send this chat as screenshot to the developers to investigate further",
            )
        else:
            logger.error("No phone number or BSUID in the payload, so the user could not be notified")
        return create_response_for_meta(
            success=False,
            message="Unexpected message format received from Meta",
            status_code=400,
            error_code="UNEXPECTED_PAYLOAD_FORMAT",
            details={"error": str(e)},
        )
    except Exception as e:
        logger.exception(f"Error extracting message details: {e}")
        sentry_sdk.set_tag("error_type", "webhook_processing_failure")
        sentry_sdk.set_context(
            "webhook_details",
            {
                "request_id": request_id_var.get(),
            },
        )
        sentry_sdk.capture_exception(e)
        return create_response_for_meta(
            success=False,
            message="Error processing webhook payload",
            status_code=400,
            error_code="INVALID_PAYLOAD",
            details={"error": str(e)},
        )

    # Create a user-specific conversation manager instance for this request
    conversation_manager = WhatsAppConversationManager(
        bsuid=bsuid,
        incoming_msg_type=incoming_msg_type,
        incoming_msg_body=incoming_msg_body,
        message_id=message_id,
        message_unix_time=message_unix_time,
    )

    # Check if the WhatsApp service is enabled
    if get_settings().WA_MAINTENANCE_MODE:
        # Inform the user that the service is down for maintenance
        background_tasks.add_task(
            conversation_manager.send_whatsapp_message,
            "Ansari for WhatsApp is down for maintenance, please try again later or visit our website at https://ansari.chat.",
        )
        return create_response_for_meta(
            success=False, message="Service under maintenance", status_code=503, error_code="MAINTENANCE_MODE"
        )

    # Temporary corner case while locally developing:
    #   Since the staging server is always running,
    #   and since we currently have the same testing number for both staging and local testing,
    #   therefore we need an indicator that a message is meant for a dev who's testing locally now
    #   and not for the staging server.
    #   This is done by prefixing the message with "!d " (e.g., "!d what is ansari?")
    # NOTE: Obviously, this temp. solution will be removed when we get a dedicated testing number for staging testing.
    # (An unsupported message type arrives as a list, not a dict, so only look inside a dict.)
    if (
        get_settings().DEPLOYMENT_TYPE == "staging"
        and isinstance(incoming_msg_body, dict)
        and incoming_msg_body.get("body", "").startswith("!d ")
    ):
        logger.debug("Incoming message is meant for a dev who's testing locally now, so will not process it in staging...")
        return create_response_for_meta(
            success=False, message="Message filtered for local development", status_code=202, error_code="DEV_FILTER"
        )

    # Check if there are more than xx hours have passed from the user's message to the current time
    # If so, send a message to the user and return
    if is_message_too_old(message_unix_time):
        return create_response_for_meta(
            success=False, message="Message too old, ignored", status_code=422, error_code="MESSAGE_TOO_OLD"
        )

    # Check if the incoming message is a media type other than text (needs no sign-in)
    if incoming_msg_type != "text":
        background_tasks.add_task(
            conversation_manager.handle_unsupported_message,
        )
        return create_response_for_meta(
            success=False, message="Unsupported message type handled", status_code=415, error_code="UNSUPPORTED_MESSAGE_TYPE"
        )

    # Sign-in (apps/auth), typing indicator and answer all run after Meta has its reply: a slow apps/auth
    # must not make Meta redeliver the message, as nothing dedupes redeliveries.
    background_tasks.add_task(
        conversation_manager.sign_in_and_handle_text_message,
    )

    return create_response_for_meta(success=True, message="Message processed successfully")


if __name__ == "__main__":
    # This block is executed when the script is run directly
    # Alternative: Run with uvicorn command for auto-reload on .env file changes:
    #   uvicorn src.ansari_whatsapp.app.main:app --reload --reload-include .env
    import uvicorn
    import os

    settings = get_settings()

    # Determine module path for uvicorn dynamically
    #   (E.g.: ansari_whatsapp.app.main:app)
    file_path = os.path.abspath(__file__)
    module_path = os.path.relpath(file_path, os.getcwd())
    module_name = module_path.replace(os.sep, ".").replace(".py", "").replace("src.", "", 1) + ":app"
    logger.debug(f"Running FastAPI app with module name: {module_name}")

    if settings.DEPLOYMENT_TYPE == "local":
        host = "localhost"
        reload_uvicorn = True
        reload_includes = [".env"]
    else:
        host = "0.0.0.0"
        reload_uvicorn = False
        reload_includes = None

    # Run the FastAPI app with uvicorn
    uvicorn.run(
        module_name,  # Dynamically constructed module path
        host=host,
        port=int(os.getenv("PORT", "8001")),  # Railway's public domain targets the service's PORT variable
        reload=reload_uvicorn,
        reload_includes=reload_includes,
        log_level="info",  # Uvicorn expects lowercase log levels
    )
