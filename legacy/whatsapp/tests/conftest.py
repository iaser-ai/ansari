import os

# Mock mode and dummy credentials so the suite runs with no backend. Exported env vars win, but a .env value does not.
for key, value in {
    "ENVIRONMENT": "development",
    "MOCK_META_API": "True",
    "MOCK_ANSARI_CLIENT": "True",
    "MOCK_AUTH_CLIENT": "True",
    "ALWAYS_RETURN_OK_TO_META": "False",
    "AUTH_WHATSAPP_API_KEY": "test",
    "META_BUSINESS_PHONE_NUMBER_ID": "123456789",
    "META_WEBHOOK_VERIFY_TOKEN": "test",
    "META_ANSARI_APP_SECRET": "test",
    "META_ACCESS_TOKEN_FROM_SYS_USER": "test",
}.items():
    os.environ.setdefault(key, value)

# A real token in a developer's .env would make every BSUID the same user
os.environ["MOCK_AUTH_TOKEN"] = ""

import pytest


@pytest.fixture(autouse=True)
def answers_unprefixed_messages():
    """Start every test as production, which answers a message with no prefix.

    The suite has to start as `development` (the only one that may switch mocks on), which would ignore such a message.
    Setting the value after start-up skips that check, and a test that needs another environment sets its own.
    """
    from ansari_whatsapp.utils.config import get_settings

    settings = get_settings()
    original = settings.ENVIRONMENT
    settings.ENVIRONMENT = "production"
    yield
    settings.ENVIRONMENT = original
