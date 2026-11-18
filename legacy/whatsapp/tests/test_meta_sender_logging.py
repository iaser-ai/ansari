"""The Meta sender logs Meta's error as structured, masked fields, and never a phone number, BSUID or message text
outside development (spec 321, follow-up #339 review)."""

import asyncio
import json

import httpx
import pytest
from loguru import logger

from ansari_whatsapp.services.meta_api_service_real import MetaApiServiceReal
from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.log_masking import mask_identifiers

BSUID = "US.13491208655302741918"
PHONE = "201234567899"
MESSAGE_TEXT = "a-very-distinctive-reply-text"
TRACE_ID = "Axly7O1UTgCLGu6n8EXWWTD"
# What Meta sent for a recipient who was not on the test number's list
META_REPLY = json.dumps(
    {
        "error": {
            "message": "(#131030) Recipient phone number not in allowed list",
            "type": "OAuthException",
            "code": 131030,
            "error_data": {
                "messaging_product": "whatsapp",
                "details": "Recipient phone number not in allowed list: Add recipient phone number to recipient list.",
            },
            "fbtrace_id": TRACE_ID,
        }
    }
)
# A reply that echoes the recipient, which Meta's docs do not rule out
ECHOING_REPLY = json.dumps(
    {
        "error": {
            "message": f"(#131030) Recipient {PHONE} is not allowed",
            "type": "OAuthException",
            "code": 131030,
            "error_data": {"messaging_product": "whatsapp", "details": f"Cannot send to +{PHONE} or {BSUID}"},
            "fbtrace_id": TRACE_ID,
        }
    }
)

_RealAsyncClient = httpx.AsyncClient


def _meta_answers(monkeypatch, response: httpx.Response, seen: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(json.loads(request.content))
        return response

    monkeypatch.setattr(
        "ansari_whatsapp.services.meta_api_service_real.httpx.AsyncClient",
        lambda **kw: _RealAsyncClient(transport=httpx.MockTransport(handler), **kw),
    )


def _failed_send_log(method: str, recipient: str = BSUID) -> str:
    service = MetaApiServiceReal()
    captured = []
    sink_id = logger.add(lambda m: captured.append(str(m)), level="DEBUG")
    try:
        with pytest.raises(httpx.HTTPStatusError):
            if method == "send_message":
                asyncio.run(service.send_message(recipient, [MESSAGE_TEXT]))
            else:
                asyncio.run(service.send_typing_indicator(recipient, "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI1RjQy"))
    finally:
        logger.remove(sink_id)
    return "\n".join(captured)


@pytest.mark.parametrize("environment", ["development", "staging", "production"])
@pytest.mark.parametrize("method", ["send_message", "send_typing_indicator"])
def test_meta_error_fields_are_logged_in_every_environment(monkeypatch, method, environment):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", environment)
    _meta_answers(monkeypatch, httpx.Response(400, text=META_REPLY))

    log_text = _failed_send_log(method)

    assert "code=131030" in log_text
    assert "type='OAuthException'" in log_text
    assert f"fbtrace_id='{TRACE_ID}'" in log_text
    assert "Recipient phone number not in allowed list" in log_text


@pytest.mark.parametrize("environment", ["development", "staging", "production"])
@pytest.mark.parametrize("method", ["send_message", "send_typing_indicator"])
def test_an_error_that_echoes_the_recipient_is_masked_in_every_environment(monkeypatch, method, environment):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", environment)
    _meta_answers(monkeypatch, httpx.Response(400, text=ECHOING_REPLY))

    log_text = _failed_send_log(method, recipient="US.99999999999999999999")
    meta_line = next(line for line in log_text.splitlines() if "Meta's reply" in line)

    assert PHONE not in meta_line
    assert BSUID not in meta_line
    assert "code=131030" in meta_line
    assert "<phone>" in meta_line and "<bsuid>" in meta_line


@pytest.mark.parametrize("environment", ["staging", "production"])
@pytest.mark.parametrize("recipient", [PHONE, BSUID])
@pytest.mark.parametrize("method", ["send_message", "send_typing_indicator"])
def test_no_phone_bsuid_message_text_or_message_id_is_logged_outside_development(monkeypatch, method, recipient, environment):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", environment)
    _meta_answers(monkeypatch, httpx.Response(400, text=ECHOING_REPLY))

    log_text = _failed_send_log(method, recipient)

    assert PHONE not in log_text
    assert BSUID not in log_text
    assert MESSAGE_TEXT not in log_text
    assert "wamid" not in log_text
    assert get_settings().META_ACCESS_TOKEN_FROM_SYS_USER.get_secret_value() not in log_text


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_a_400_logs_which_keys_were_sent_but_not_their_values(monkeypatch, environment):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", environment)
    _meta_answers(monkeypatch, httpx.Response(400, text=META_REPLY))

    log_text = _failed_send_log("send_message", PHONE)

    assert "Payload keys: ['messaging_product', 'text', 'to', 'type']" in log_text


def test_development_logs_the_full_request_body_but_never_the_token(monkeypatch):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", "development")
    _meta_answers(monkeypatch, httpx.Response(400, text=META_REPLY))

    log_text = _failed_send_log("send_message", PHONE)

    assert MESSAGE_TEXT in log_text
    assert PHONE in log_text
    assert "Bearer ***" in log_text
    assert get_settings().META_ACCESS_TOKEN_FROM_SYS_USER.get_secret_value() not in log_text


def test_staging_logs_a_masked_body_with_the_safe_fields_readable(monkeypatch):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", "staging")
    _meta_answers(monkeypatch, httpx.Response(400, text=META_REPLY))

    log_text = _failed_send_log("send_message", PHONE)

    assert "Body with values masked" in log_text
    assert "'type': 'text'" in log_text
    assert "<str len=" in log_text
    assert "Bearer ***" in log_text


def test_production_logs_no_request_values_and_no_headers(monkeypatch):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", "production")
    _meta_answers(monkeypatch, httpx.Response(400, text=META_REPLY))

    log_text = _failed_send_log("send_message", PHONE)

    assert "Body" not in log_text
    assert "Headers" not in log_text
    assert "Bearer" not in log_text


def test_request_details_are_only_logged_for_a_400(monkeypatch):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", "development")
    _meta_answers(monkeypatch, httpx.Response(403, text=META_REPLY))

    log_text = _failed_send_log("send_message")

    assert "code=131030" in log_text
    assert MESSAGE_TEXT not in log_text
    assert "Payload keys" not in log_text


def test_a_reply_that_is_not_the_standard_error_object_logs_only_its_size(monkeypatch):
    monkeypatch.setattr(get_settings(), "ENVIRONMENT", "production")
    _meta_answers(monkeypatch, httpx.Response(400, text=f"upstream said {PHONE} {BSUID} <html>"))

    log_text = _failed_send_log("send_message", PHONE)

    assert "no standard error object" in log_text
    assert PHONE not in log_text
    assert BSUID not in log_text


@pytest.mark.parametrize(
    ("text", "masked"),
    [
        ("Recipient 201234567899 not allowed", "Recipient <phone> not allowed"),
        ("Recipient +20 123 456-7899 not allowed", "Recipient <phone> not allowed"),
        ("Recipient (631) 555-1234 not allowed", "Recipient <phone> not allowed"),
        ("user EG.3225570644499982 blocked", "user <bsuid> blocked"),
        ("user US.ENT.11815799212886844830 blocked", "user <bsuid> blocked"),
        ("id wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI1RjQy= end", "id <message-id> end"),
        ("(#131030) Recipient phone number not in allowed list", "(#131030) Recipient phone number not in allowed list"),
        ("code 2655007 and trace Axly7O1UTgCLGu6n8EXWWTD", "code 2655007 and trace Axly7O1UTgCLGu6n8EXWWTD"),
    ],
)
def test_masking_hides_identifier_shapes_and_leaves_ordinary_text(text, masked):
    assert mask_identifiers(text) == masked


@pytest.mark.parametrize(
    ("recipient", "expected"),
    [
        (PHONE, {"to": PHONE}),
        (BSUID, {"recipient_type": "individual", "recipient": BSUID}),
    ],
)
def test_text_payload_addresses_phone_in_to_and_bsuid_in_recipient(monkeypatch, recipient, expected):
    sent = []
    _meta_answers(monkeypatch, httpx.Response(200, json={"messages": [{"id": "wamid.X"}]}), sent)

    asyncio.run(MetaApiServiceReal().send_message(recipient, [MESSAGE_TEXT]))

    assert len(sent) == 1
    assert sent[0]["type"] == "text"
    assert sent[0]["text"] == {"body": MESSAGE_TEXT}
    assert {k: v for k, v in sent[0].items() if k in ("to", "recipient", "recipient_type")} == expected


@pytest.mark.parametrize("method", ["send_message", "send_typing_indicator"])
def test_sender_uses_an_explicit_timeout_longer_than_httpx_default(monkeypatch, method):
    seen = {}

    def fake_client(**kw):
        seen.update(kw)
        return _RealAsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})), **kw)

    monkeypatch.setattr("ansari_whatsapp.services.meta_api_service_real.httpx.AsyncClient", fake_client)
    service = MetaApiServiceReal()

    if method == "send_message":
        asyncio.run(service.send_message(PHONE, [MESSAGE_TEXT]))
    else:
        asyncio.run(service.send_typing_indicator(PHONE, "wamid.T"))

    assert seen["timeout"].read == 20.0
    assert seen["timeout"].connect == 10.0


def test_webhook_error_logs_mask_the_ids_in_the_payload():
    from ansari_whatsapp.utils.whatsapp_webhook_utils import _redact_for_logging

    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "102290129340398",
                "changes": [
                    {"value": {"messages": [{"from": PHONE, "from_user_id": BSUID, "id": "wamid.HBgL", "type": "text"}]}}
                ],
            }
        ],
    }

    logged = str(_redact_for_logging(payload))

    for secret in (PHONE, BSUID, "102290129340398", "wamid.HBgL"):
        assert secret not in logged
    assert "whatsapp_business_account" in logged and "'type': 'text'" in logged
