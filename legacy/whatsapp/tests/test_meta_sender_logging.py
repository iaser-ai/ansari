"""The Meta sender always logs Meta's error reply, and the request we sent only outside production."""

import asyncio
import json

import httpx
import pytest
from loguru import logger

from ansari_whatsapp.services.meta_api_service_real import MetaApiServiceReal
from ansari_whatsapp.utils.config import get_settings

BSUID = "US.13491208655302741918"
PHONE = "201234567899"
MESSAGE_TEXT = "a-very-distinctive-reply-text"
META_REPLY = '{"error":{"message":"(#131030) Recipient phone number not in allowed list","code":131030}}'

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


def _failed_send_log(method: str) -> str:
    service = MetaApiServiceReal()
    captured = []
    sink_id = logger.add(lambda m: captured.append(str(m)), level="DEBUG")
    try:
        with pytest.raises(httpx.HTTPStatusError):
            if method == "send_message":
                asyncio.run(service.send_message(BSUID, [MESSAGE_TEXT]))
            else:
                asyncio.run(service.send_typing_indicator(BSUID, "wamid.T"))
    finally:
        logger.remove(sink_id)
    return "\n".join(captured)


@pytest.mark.parametrize("deployment_type", ["local", "staging", "production"])
@pytest.mark.parametrize("method", ["send_message", "send_typing_indicator"])
def test_meta_reply_is_logged_in_every_environment(monkeypatch, method, deployment_type):
    monkeypatch.setattr(get_settings(), "DEPLOYMENT_TYPE", deployment_type)
    _meta_answers(monkeypatch, httpx.Response(400, text=META_REPLY))

    log_text = _failed_send_log(method)

    assert "400" in log_text
    assert "Recipient phone number not in allowed list" in log_text


@pytest.mark.parametrize("deployment_type", ["local", "staging"])
def test_request_details_are_logged_outside_production_without_the_token(monkeypatch, deployment_type):
    monkeypatch.setattr(get_settings(), "DEPLOYMENT_TYPE", deployment_type)
    _meta_answers(monkeypatch, httpx.Response(400, text=META_REPLY))

    log_text = _failed_send_log("send_message")

    assert MESSAGE_TEXT in log_text
    assert BSUID in log_text
    assert "Bearer ***" in log_text
    assert get_settings().META_ACCESS_TOKEN_FROM_SYS_USER.get_secret_value() not in log_text


@pytest.mark.parametrize("method", ["send_message", "send_typing_indicator"])
def test_production_never_logs_the_request_we_sent(monkeypatch, method):
    monkeypatch.setattr(get_settings(), "DEPLOYMENT_TYPE", "production")
    _meta_answers(monkeypatch, httpx.Response(400, text=META_REPLY))

    log_text = _failed_send_log(method)

    assert MESSAGE_TEXT not in log_text
    assert BSUID not in log_text
    assert "Bearer" not in log_text


def test_request_details_are_only_logged_for_a_400(monkeypatch):
    monkeypatch.setattr(get_settings(), "DEPLOYMENT_TYPE", "staging")
    _meta_answers(monkeypatch, httpx.Response(403, text=META_REPLY))

    log_text = _failed_send_log("send_message")

    assert "Recipient phone number not in allowed list" in log_text
    assert MESSAGE_TEXT not in log_text


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
