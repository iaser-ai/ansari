"""Tests for maintenance mode and the prefix routing between production, staging and development (spec 321, issue #363)."""

import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

from ansari_whatsapp.app.main import app
from ansari_whatsapp.services.ansari_client_mock import AnsariClientMock
from ansari_whatsapp.services.meta_api_service_mock import MetaApiServiceMock
from ansari_whatsapp.services.service_provider import reset_ansari_client, reset_auth_client
from ansari_whatsapp.utils.config import get_settings

BSUID = "US.13491208655302741918"
client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_singletons():
    reset_ansari_client()
    reset_auth_client()
    yield
    reset_ansari_client()
    reset_auth_client()


def _post(body_text: str):
    settings = get_settings()
    value = {
        "metadata": {
            "phone_number_id": settings.META_BUSINESS_PHONE_NUMBER_ID.get_secret_value(),
            "display_phone_number": "+1234567890",
        },
        "messages": [
            {
                "from_user_id": BSUID,
                "id": "wamid.TEST",
                "timestamp": str(int(time.time())),
                "type": "text",
                "text": {"body": body_text},
            }
        ],
    }
    payload = {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    secret = settings.META_ANSARI_APP_SECRET.get_secret_value().encode("utf-8")
    signature = hmac.new(secret, body, hashlib.sha256).hexdigest()
    return client.post("/whatsapp/v2", content=body, headers={"X-Hub-Signature-256": f"sha256={signature}"})


def _spy_on_chat_calls(monkeypatch) -> list:
    calls = []
    original = AnsariClientMock.process_message

    async def spy(self, token, thread_id, message):
        calls.append(message)
        return await original(self, token, thread_id, message)

    monkeypatch.setattr(AnsariClientMock, "process_message", spy)
    monkeypatch.setattr("ansari_whatsapp.services.ansari_client_mock.random.uniform", lambda a, b: 0)
    return calls


def _spy_on_replies(monkeypatch) -> list:
    replies = []
    original = MetaApiServiceMock.send_message

    async def spy(self, recipient_bsuid_or_phone, message_parts):
        replies.extend(message_parts)
        return await original(self, recipient_bsuid_or_phone, message_parts)

    monkeypatch.setattr(MetaApiServiceMock, "send_message", spy)
    return replies


def test_maintenance_mode_on_sends_the_notice_and_makes_no_chat_call(monkeypatch):
    monkeypatch.setattr(get_settings(), "WA_MAINTENANCE_MODE", True)
    chat_calls = _spy_on_chat_calls(monkeypatch)
    replies = _spy_on_replies(monkeypatch)

    response = _post("hello")

    assert response.json()["error_code"] == "MAINTENANCE_MODE"
    assert chat_calls == []
    assert any("down for maintenance" in part for part in replies)


def test_maintenance_mode_off_answers_normally(monkeypatch):
    monkeypatch.setattr(get_settings(), "WA_MAINTENANCE_MODE", False)
    chat_calls = _spy_on_chat_calls(monkeypatch)

    response = _post("hello")

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert chat_calls == ["hello"]


def test_apps_api_maintenance_variable_does_not_affect_this_service(monkeypatch):
    monkeypatch.setenv("MAINTENANCE_MODE", "true")
    get_settings.cache_clear()
    try:
        assert get_settings().WA_MAINTENANCE_MODE is False
    finally:
        get_settings.cache_clear()


def _post_unsupported():
    """Meta sends an unsupported type (video note, poll...) as an `errors` list, not a dict with a body."""

    settings = get_settings()

    value = {
        "metadata": {
            "phone_number_id": settings.META_BUSINESS_PHONE_NUMBER_ID.get_secret_value(),
            "display_phone_number": "+1234567890",
        },
        "messages": [
            {
                "from_user_id": BSUID,
                "id": "wamid.TEST",
                "timestamp": str(int(time.time())),
                "type": "unsupported",
                "errors": [{"code": 131051, "title": "Message type is not supported"}],
            }
        ],
    }

    payload = {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}

    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")

    secret = settings.META_ANSARI_APP_SECRET.get_secret_value().encode("utf-8")

    signature = hmac.new(secret, body, hashlib.sha256).hexdigest()

    return client.post("/whatsapp/v2", content=body, headers={"X-Hub-Signature-256": f"sha256={signature}"})


# ---------- prefix routing: one number feeds production, staging and development (issue #363) ----------


QUESTION = "what is ansari?"

# environment -> what it answers, as (message text -> the text the chat receives); anything else is ignored

ANSWERS = {
    "production": {QUESTION: QUESTION},
    "staging": {f"!s {QUESTION}": QUESTION},
    "development": {f"!d {QUESTION}": QUESTION},
}

MESSAGES = [QUESTION, f"!d {QUESTION}", f"!s {QUESTION}"]


@pytest.mark.parametrize("message", MESSAGES)
@pytest.mark.parametrize("environment", list(ANSWERS))
def test_each_environment_answers_only_its_own_messages(monkeypatch, environment, message):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", environment)

    chat_calls = _spy_on_chat_calls(monkeypatch)

    response = _post(message)

    expected = ANSWERS[environment].get(message)

    if expected is None:
        assert response.json()["error_code"] == "DEV_FILTER"

        assert chat_calls == []

    else:
        assert response.status_code == 200

        assert response.json()["success"] is True

        assert chat_calls == [expected], "the answering environment must not pass its prefix on to apps/api"


@pytest.mark.parametrize("message", ["!dwhat", "!swhat", "!D what", "!S what", " !s what", "!x what"])
def test_production_answers_anything_that_is_not_exactly_a_prefix(monkeypatch, message):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", "production")

    chat_calls = _spy_on_chat_calls(monkeypatch)

    response = _post(message)

    assert response.status_code == 200

    assert chat_calls == [message]


@pytest.mark.parametrize("environment", ["staging", "development"])
def test_non_production_environments_ignore_a_message_of_a_type_they_cannot_read(monkeypatch, environment):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", environment)

    replies = _spy_on_replies(monkeypatch)

    response = _post_unsupported()

    assert response.json()["error_code"] == "DEV_FILTER"

    assert replies == []


def test_production_answers_an_unsupported_message_type_without_crashing(monkeypatch):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", "production")

    chat_calls = _spy_on_chat_calls(monkeypatch)

    response = _post_unsupported()

    assert response.json()["error_code"] == "UNSUPPORTED_MESSAGE_TYPE"

    assert chat_calls == []


@pytest.mark.parametrize(("environment", "message"), [("staging", QUESTION), ("production", f"!s {QUESTION}")])
def test_an_environment_that_ignores_a_message_never_sends_the_maintenance_notice(monkeypatch, environment, message):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", environment)

    monkeypatch.setattr(get_settings(), "WA_MAINTENANCE_MODE", True)

    replies = _spy_on_replies(monkeypatch)

    response = _post(message)

    assert response.json()["error_code"] == "DEV_FILTER"

    assert replies == [], "three environments would otherwise each send their own notice for one message"


def test_the_environment_that_answers_still_sends_the_maintenance_notice(monkeypatch):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", "staging")

    monkeypatch.setattr(get_settings(), "WA_MAINTENANCE_MODE", True)

    replies = _spy_on_replies(monkeypatch)

    response = _post(f"!s {QUESTION}")

    assert response.json()["error_code"] == "MAINTENANCE_MODE"

    assert any("down for maintenance" in part for part in replies)


@pytest.mark.parametrize(("environment", "message"), [("staging", QUESTION), ("production", f"!d {QUESTION}")])
def test_an_ignored_message_leaves_no_phone_number_bsuid_or_text_in_the_logs(monkeypatch, environment, message):
    from loguru import logger

    monkeypatch.setattr(get_settings(), "ENVIRONMENT", environment)

    captured = []

    sink_id = logger.add(lambda m: captured.append(str(m)), level="DEBUG")

    try:
        response = _post(message)

    finally:
        logger.remove(sink_id)

    assert response.json()["error_code"] == "DEV_FILTER"

    log_text = "\n".join(captured)

    assert "meant for another environment" in log_text

    assert BSUID not in log_text

    assert QUESTION not in log_text


@pytest.mark.parametrize(
    ("environment", "body", "answers", "expected_body"),
    [
        ("production", {"body": "hi"}, True, {"body": "hi"}),
        ("production", {"body": "!s hi"}, False, {"body": "!s hi"}),
        ("staging", {"body": "!s hi"}, True, {"body": "hi"}),
        ("staging", {"body": "hi"}, False, {"body": "hi"}),
        ("development", {"body": "!d hi"}, True, {"body": "hi"}),
        ("development", {"body": "!s hi"}, False, {"body": "!s hi"}),
        ("staging", {"body": "!s "}, True, {"body": ""}),
        ("production", [{"code": 131051}], True, [{"code": 131051}]),
        ("staging", [{"code": 131051}], False, [{"code": 131051}]),
        ("development", None, False, None),
    ],
)
def test_route_by_prefix(environment, body, answers, expected_body):
    from ansari_whatsapp.utils.prefix_routing import route_by_prefix

    assert route_by_prefix(environment, body) == (answers, expected_body)


def test_route_by_prefix_does_not_change_the_body_it_was_given():
    from ansari_whatsapp.utils.prefix_routing import route_by_prefix

    original = {"body": "!s hi"}

    route_by_prefix("staging", original)

    assert original == {"body": "!s hi"}


# ---------- start-up checks and request hardening (Amr's review of PR 327) ----------


@pytest.mark.parametrize("environment", ["development", "staging", "production"])
def test_start_up_fails_without_the_app_secret(monkeypatch, environment):
    from ansari_whatsapp.utils.config import WhatsAppSettings

    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.delenv("META_ANSARI_APP_SECRET")

    with pytest.raises(ValueError, match="META_ANSARI_APP_SECRET"):
        WhatsAppSettings(_env_file=None)


@pytest.mark.parametrize(("environment", "expected"), [("development", "DEBUG"), ("staging", "INFO"), ("production", "INFO")])
def test_log_level_defaults_to_info_outside_development(monkeypatch, environment, expected):
    from ansari_whatsapp.utils.config import WhatsAppSettings

    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.delenv("LOGGING_LEVEL", raising=False)
    if environment != "development":
        for flag in ("MOCK_ANSARI_CLIENT", "MOCK_AUTH_CLIENT", "MOCK_META_API"):
            monkeypatch.setenv(flag, "False")

    assert WhatsAppSettings(_env_file=None).LOGGING_LEVEL == expected


def test_local_is_no_longer_an_environment(monkeypatch):
    from ansari_whatsapp.utils.config import WhatsAppSettings

    monkeypatch.setenv("ENVIRONMENT", "local")
    # Mocks are refused outside development with a message that also names ENVIRONMENT, which would hide a missing refusal
    for flag in ("MOCK_ANSARI_CLIENT", "MOCK_AUTH_CLIENT", "MOCK_META_API"):
        monkeypatch.setenv(flag, "False")

    with pytest.raises(ValueError, match="should match pattern"):
        WhatsAppSettings(_env_file=None)


def test_the_environment_is_required_and_the_old_name_is_not_read(monkeypatch):
    from ansari_whatsapp.utils.config import WhatsAppSettings

    monkeypatch.delenv("ENVIRONMENT")

    monkeypatch.setenv("DEPLOYMENT_TYPE", "development")

    with pytest.raises(ValueError, match="ENVIRONMENT"):
        WhatsAppSettings(_env_file=None)


def test_an_explicit_log_level_wins(monkeypatch):
    from ansari_whatsapp.utils.config import WhatsAppSettings

    monkeypatch.setenv("LOGGING_LEVEL", "WARNING")

    assert WhatsAppSettings(_env_file=None).LOGGING_LEVEL == "WARNING"


def _sign(body: bytes) -> dict:
    secret = get_settings().META_ANSARI_APP_SECRET.get_secret_value().encode("utf-8")
    return {"X-Hub-Signature-256": "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()}


@pytest.mark.parametrize("body", [b"this is not json", b"", b"\xff\xfe"])
def test_a_signed_body_that_is_not_json_is_a_400_not_a_crash(body):
    response = client.post("/whatsapp/v2", content=body, headers=_sign(body))

    assert response.status_code == 400
    assert response.json()["error_code"] == "INVALID_PAYLOAD"


def _handshake(token: str):
    return client.get("/whatsapp/v2", params={"hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "abc123"})


def test_handshake_accepts_the_right_token_and_refuses_others():
    right = get_settings().META_WEBHOOK_VERIFY_TOKEN.get_secret_value()

    assert _handshake(right).text == "abc123"
    assert _handshake(right + "x").status_code == 403
    assert _handshake(right[:-1]).status_code == 403


def test_handshake_with_a_non_ascii_token_is_refused_not_a_crash():
    assert _handshake("t\u00e9st").status_code == 403
