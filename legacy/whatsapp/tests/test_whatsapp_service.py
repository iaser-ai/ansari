"""
Integration tests for ansari-whatsapp service webhooks.

This module tests the WhatsApp webhook endpoints in the ansari-whatsapp service
using pytest and FastAPI TestClient. It focuses solely on testing the WhatsApp
service itself without external dependencies.

Tests verify:
- Service health endpoint
- Webhook verification endpoint
- Webhook message processing
- Phone number validation logic

Backend Availability:
- If MOCK_ANSARI_CLIENT=True: Tests use mock client (no backend needed)
- If MOCK_ANSARI_CLIENT=False: Tests check backend availability
  - If backend is available: Tests proceed with real backend
  - If backend is NOT available: Tests terminate with error instructions

Required Environment Variables:
- META_BUSINESS_PHONE_NUMBER_ID: Your Meta business phone number ID
- MOCK_ANSARI_CLIENT: True for mock mode, False for real backend
- MOCK_META_API: True for mock mode (default), False for real Meta API
- BACKEND_SERVER_URL: URL of backend service (required if MOCK_ANSARI_CLIENT=False)

Security: All sensitive data is loaded from environment variables and masked in logs.
"""

import json
import pytest
import time
import httpx
import hmac
import hashlib
from typing import Any

from fastapi.testclient import TestClient

# This `logger` will get configured when importing `ansari_whatsapp.app.main` below,
# as `main.py` calls `configure_logger()`
from loguru import logger

from ansari_whatsapp.app.main import app
from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.services.service_provider import reset_ansari_client
from ansari_whatsapp.utils.general_helpers import get_base_url
from .test_utils import log_test_result, format_payload_for_logging, format_params_for_logging


def check_backend_availability() -> bool:
    """Check if the ansari-backend service is running and accessible.

    Returns:
        bool: True if backend is available, False otherwise
    """
    settings = get_settings()
    backend_url = settings.BACKEND_SERVER_URL

    # Use base URL since health check is at root endpoint in ansari-backend
    base_backend_url = get_base_url(backend_url)

    try:
        logger.info(f"Checking backend availability at {base_backend_url}")
        response = httpx.get(f"{base_backend_url}/", timeout=3.0)
        is_available = response.status_code == 200
        logger.info(f"Backend availability: {'AVAILABLE' if is_available else 'UNAVAILABLE'} (status: {response.status_code})")
        return is_available
    except httpx.RequestError as e:
        logger.info(f"Backend is not available: {e}")
        return False
    except Exception as e:
        logger.warning(f"Unexpected error checking backend: {e}")
        return False


@pytest.fixture(scope="module", autouse=True)
def configure_mock_mode():
    """Configure mock mode based on backend availability before running tests.

    This fixture runs before all tests and checks the MOCK_ANSARI_CLIENT setting.
    If MOCK_ANSARI_CLIENT is True, tests will use a mock client.
    If MOCK_ANSARI_CLIENT is False, tests will check backend availability.

    If backend is not available and mock mode is disabled, tests will terminate
    with clear instructions on how to fix the issue.

    The original value (if any) is restored after tests complete.
    """
    # Get settings first to check current configuration
    settings = get_settings()

    # Log the current mock mode setting
    if settings.MOCK_ANSARI_CLIENT:
        logger.info("MOCK_ANSARI_CLIENT is True - Tests will use MOCK client")
        logger.info("Backend availability check will be skipped")
    else:
        logger.info("MOCK_ANSARI_CLIENT is False - Tests will use REAL backend")
        logger.info("Checking backend availability...")

        # Check if backend is available
        backend_available = check_backend_availability()

        if not backend_available:
            error_message = f"""
{"=" * 80}
BACKEND IS NOT AVAILABLE
{"=" * 80}

The backend server is not reachable, but MOCK_ANSARI_CLIENT is set to False.

To fix this issue, you have the following options:

Option 1: Enable mock mode
  Set MOCK_ANSARI_CLIENT=True (e.g., in your .env file, GitHub Actions, etc.)
  This will run tests with a mock client (no backend needed)

Option 2: Fix the backend URL
  Current BACKEND_SERVER_URL: {settings.BACKEND_SERVER_URL}
  Ensure the BACKEND_SERVER_URL is correct

Option 3: Start the backend server
  If BACKEND_SERVER_URL is correct, ensure the ansari-backend
  service is running on {settings.BACKEND_SERVER_URL}

{"=" * 80}
"""
            logger.error(error_message)
            pytest.exit(
                "Backend not available and MOCK_ANSARI_CLIENT=False. See error message above for solutions.", returncode=1
            )

    # Log the effective configuration
    logger.info(f"Test configuration: MOCK_ANSARI_CLIENT = {settings.MOCK_ANSARI_CLIENT}")
    logger.info(f"Backend URL: {settings.BACKEND_SERVER_URL}")

    yield

    # No teardown actions needed for this fixture


@pytest.fixture(scope="function", autouse=True)
def reset_client_singleton():
    """Reset the Ansari client singleton before each test for proper isolation.

    This fixture ensures that each test function gets a fresh Ansari client instance,
    preventing state leakage between tests. This is important IN CASE:
    - Tests modify environment variables (e.g., MOCK_ANSARI_CLIENT)
    - Tests need different client configurations

    The reset happens BEFORE each test runs, so the test gets a fresh singleton
    based on the current environment configuration.
    """
    reset_ansari_client()
    logger.debug("Test fixture: Ansari client singleton reset before test")
    yield
    # No cleanup needed after test - next test will reset again


@pytest.fixture(scope="module")
def settings():
    return get_settings()


# Create TestClient
client = TestClient(app)

# Test results storage
test_results = []


def log_test_result_to_list(test_name: str, success: bool, message: str, response_data: Any = None):
    """Log test results."""
    result = log_test_result(test_name, success, message, response_data)
    test_results.append(result)

    status = "[PASS]" if success else "[FAIL]"
    logger.info(f"{status} {test_name}: {message}")

    if response_data:
        logger.debug(f"   Response: {json.dumps(result['response_data'], indent=2)}")


@pytest.mark.integration
def test_whatsapp_health():
    """Test ansari-whatsapp health endpoint using TestClient."""
    test_name = "WhatsApp Service Health"

    response = client.get("/")
    response_data = response.json()

    if response.status_code == 200 and response_data.get("status") == "ok":
        log_test_result_to_list(test_name, True, "WhatsApp service is healthy", response_data)
        assert True
    else:
        log_test_result_to_list(test_name, False, f"Health check failed: HTTP {response.status_code}", response_data)
        assert False


@pytest.mark.integration
def test_webhook_verification(settings):
    """Test WhatsApp webhook verification endpoint using TestClient."""
    test_name = "Webhook Verification"

    params = {
        "hub.mode": "subscribe",
        "hub.verify_token": settings.META_WEBHOOK_VERIFY_TOKEN.get_secret_value(),
        "hub.challenge": "test_challenge_12345",
    }

    logger.debug(f"[TEST] Testing {test_name}...")
    logger.debug("   URL: /whatsapp/v2")
    logger.debug(f"   Params: {format_params_for_logging(params)}")

    response = client.get("/whatsapp/v2", params=params)

    if response.status_code == 200 and "test_challenge_12345" in response.text:
        log_test_result_to_list(test_name, True, "Webhook verification successful", {"response": response.text})
        assert True
    else:
        log_test_result_to_list(
            test_name, False, f"Webhook verification failed: HTTP {response.status_code}", {"response": response.text}
        )
        assert False


@pytest.mark.integration
def test_webhook_message_basic(settings):
    """Test basic WhatsApp webhook message processing using TestClient.

    With mock mode enabled (default), this test should always succeed with 200 status.
    Uses hardcoded test values (phone number and message ID) from Meta's sample webhook payloads.

    This test requires proper environment variables to be set that simulate
    a real WhatsApp message. If you encounter errors, verify:
    - META_BUSINESS_PHONE_NUMBER_ID is set
    - MOCK_META_API is set to True (default for CI/CD)

    See .env.example for details on required environment variables.
    """
    test_name = "Basic Webhook Message"

    try:
        # Create a minimal WhatsApp webhook payload
        payload = {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "metadata": {
                                    "phone_number_id": settings.META_BUSINESS_PHONE_NUMBER_ID.get_secret_value(),
                                    "display_phone_number": "+1234567890",
                                },
                                "messages": [
                                    {
                                        # NOTE: Phone number used for testing webhooks
                                        # Should be in international format without '+' or leading zeros
                                        #   (sample below has an Egyptian country code '20')
                                        # If you're testing locally and want to see messages get sent successfully
                                        # to Meta's server, temporarily update this value with your actual phone number
                                        "from": "201234567899",
                                        # Meta always sends the BSUID; the service identifies users by it alone
                                        "from_user_id": "US.13491208655302741918",
                                        # NOTE: Using hardcoded test message ID from Meta's sample webhook payloads.
                                        # This works with MOCK_META_API=True (which is the default for CI/CD).
                                        # Real message IDs have a ~30 day lifetime before becoming invalid.
                                        # Reference: https://stackoverflow.com/questions/77161282/how-can-i-reply-to-a-specific-message-using-the-whatsapp-api
                                        "id": "ABGGFlA5Fpa",
                                        "timestamp": str(int(time.time())),
                                        "type": "text",
                                        "text": {"body": "Hello, this is a test message for integration testing"},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ],
        }

        logger.debug(f"[TEST] Testing {test_name}...")
        logger.debug("   URL: /whatsapp/v2")
        logger.debug(f"   Payload: {format_payload_for_logging(payload)}")
        logger.debug(f"   Mock mode: {settings.MOCK_ANSARI_CLIENT}")

        # Generate valid Meta signature for the request
        # References:
        # - https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
        # - https://stackoverflow.com/questions/75422064/validate-x-hub-signature-256-meta-whatsapp-webhook-request
        body_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        app_secret = settings.META_ANSARI_APP_SECRET.get_secret_value().encode("utf-8")
        signature = hmac.new(app_secret, body_bytes, hashlib.sha256).hexdigest()
        headers = {"X-Hub-Signature-256": f"sha256={signature}"}

        logger.debug(f"   Generated signature: sha256={signature[:16]}... (truncated)")

        # Send request with exact body bytes and signature header
        # Note: We use content= instead of json= to ensure exact byte representation
        # This is critical because the signature is computed on the exact bytes
        response = client.post("/whatsapp/v2", content=body_bytes, headers=headers)

        # With mock client, we should always get 200
        if response.status_code == 200:
            try:
                response_data = response.json()
                success = response_data.get("success", False)
                message = response_data.get("message", "")

                if success and "processed successfully" in message.lower():
                    log_test_result_to_list(test_name, True, "Webhook message processed successfully", response_data)
                    logger.debug("   [PASS] Message processed successfully")
                else:
                    log_test_result_to_list(test_name, True, "Webhook message accepted", response_data)
                    logger.debug("   [PASS] Message accepted")

                assert True
            except json.JSONDecodeError:
                log_test_result_to_list(test_name, True, "Webhook message accepted", {"status_code": response.status_code})
                assert True
        else:
            # Non-200 status codes are now considered failures since mock client should handle everything
            response_data = None
            try:
                response_data = response.json()
            except Exception:
                response_data = response.text
            log_test_result_to_list(test_name, False, f"Expected 200, got {response.status_code}.", response_data)
            assert False, f"Expected HTTP 200 with mock client, got {response.status_code}"

    except (AttributeError, KeyError, TypeError) as e:
        error_message = f"""
{"=" * 80}
ERROR CREATING TEST PAYLOAD
{"=" * 80}

Failed to create test payload: {str(e)}

This usually means required environment variables are not set.
These variables must simulate a real WhatsApp message.

Required environment variables:
  - META_BUSINESS_PHONE_NUMBER_ID: Your Meta business phone number ID

Please check your .env file and ensure all required variables are set.
See .env.example for the complete list of required environment variables
and examples of valid values.

{"=" * 80}
"""
        logger.error(error_message)
        log_test_result_to_list(test_name, False, f"Environment variables not properly configured: {str(e)}", None)
        pytest.fail(f"Test setup failed due to missing environment variables. See error message above. Error: {str(e)}")


def _post_signed_webhook(settings, message: dict, contacts: list | None = None):
    """POST a signed webhook whose messages[0] is `message`."""
    value = {
        "metadata": {
            "phone_number_id": settings.META_BUSINESS_PHONE_NUMBER_ID.get_secret_value(),
            "display_phone_number": "+1234567890",
        },
        "messages": [message],
    }
    if contacts is not None:
        value["contacts"] = contacts
    payload = {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}
    body_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    app_secret = settings.META_ANSARI_APP_SECRET.get_secret_value().encode("utf-8")
    signature = hmac.new(app_secret, body_bytes, hashlib.sha256).hexdigest()
    return client.post("/whatsapp/v2", content=body_bytes, headers={"X-Hub-Signature-256": f"sha256={signature}"})


@pytest.mark.integration
def test_webhook_rejects_missing_signature(settings):
    """A webhook with no signature header is rejected."""
    response = client.post("/whatsapp/v2", content=b"{}")

    assert response.status_code == 403


@pytest.mark.integration
def test_webhook_rejects_wrong_signature(settings):
    """A webhook signed with the wrong secret is rejected."""
    body_bytes = b"{}"
    signature = hmac.new(b"not-the-app-secret", body_bytes, hashlib.sha256).hexdigest()

    response = client.post("/whatsapp/v2", content=body_bytes, headers={"X-Hub-Signature-256": f"sha256={signature}"})

    assert response.status_code == 403


@pytest.mark.integration
def test_webhook_phone_hidden_user(settings):
    """A BSUID-only sender (no `from`) is processed like any other user."""
    message = {
        "from_user_id": "US.13491208655302741918",
        "id": "wamid.TEST_PHONE_HIDDEN",
        "timestamp": str(int(time.time())),
        "type": "text",
        "text": {"body": "Assalamu alaikum"},
    }
    contacts = [{"profile": {"name": "Test User", "username": "testuser"}, "user_id": "US.13491208655302741918"}]

    response = _post_signed_webhook(settings, message, contacts)

    assert response.status_code == 200
    assert response.json()["success"] is True


@pytest.mark.integration
def test_webhook_missing_from_without_bsuid(settings):
    """A message with neither `from` nor `from_user_id` is reported as an unexpected format."""
    message = {
        "id": "wamid.TEST_NO_IDENTIFIER",
        "timestamp": str(int(time.time())),
        "type": "text",
        "text": {"body": "Assalamu alaikum"},
    }

    response = _post_signed_webhook(settings, message, contacts=[])

    assert response.json()["error_code"] == "UNEXPECTED_PAYLOAD_FORMAT"


@pytest.fixture(scope="session", autouse=True)
def save_results():
    """Save test results to file (runs after all tests in the session)."""
    yield  # All tests run here

    # Teardown: runs after all tests, even if filtered by -k
    from datetime import datetime

    if test_results:
        results_file = "tests/detailed_test_results_whatsapp_service.json"

        total_tests = len(test_results)
        passed_tests = sum(1 for result in test_results if result["success"])

        combined_results = {
            "test_run": {
                "timestamp": datetime.now().isoformat(),
                "total_tests": total_tests,
                "passed_tests": passed_tests,
                "failed_tests": total_tests - passed_tests,
                "success_rate": f"{(passed_tests / total_tests * 100):.1f}%" if total_tests > 0 else "0%",
            },
            "test_results": test_results,
        }

        with open(results_file, "w") as f:
            json.dump(combined_results, f, indent=2)

        logger.info(f"Detailed results saved to: {results_file}")
