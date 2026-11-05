import os

# Mock mode and dummy credentials so the suite runs with no backend. Exported env vars win, but a .env value does not.
for key, value in {
    "DEPLOYMENT_TYPE": "local",
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
