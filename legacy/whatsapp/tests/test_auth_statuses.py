"""Tests for issue #336: each apps/auth refusal means something different, and apps/api's 401 is retried once."""

import asyncio
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from ansari_whatsapp.app.main import app
from ansari_whatsapp.services.ansari_client_mock import AnsariClientMock
from ansari_whatsapp.services.auth_client_mock import AuthClientMock
from ansari_whatsapp.services.auth_client_real import DEFAULT_RETRY_AFTER_SECONDS, AuthClientReal
from ansari_whatsapp.services.meta_api_service_mock import MetaApiServiceMock
from ansari_whatsapp.services.service_provider import reset_ansari_client, reset_auth_client
from ansari_whatsapp.services.whatsapp_conversation_manager import (
    BANNED_NOTICE,
    SIGN_IN_FAILED_NOTICE,
    WhatsAppConversationManager,
)
from ansari_whatsapp.utils.exceptions import (
    ApiUnauthorizedError,
    AuthBadRequestError,
    AuthKeyRejectedError,
    AuthRateLimitedError,
    AuthTokenError,
    AuthUserBannedError,
)

BSUID = "US.13491208655302741918"

_RealAsyncClient = httpx.AsyncClient
client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_singletons(monkeypatch):
    reset_ansari_client()
    reset_auth_client()
    monkeypatch.setattr("ansari_whatsapp.services.ansari_client_mock.random.uniform", lambda a, b: 0)
    yield
    reset_ansari_client()
    reset_auth_client()


def _auth_client_answering(monkeypatch, handler) -> AuthClientReal:
    monkeypatch.setattr(
        "ansari_whatsapp.services.auth_client_real.httpx.AsyncClient",
        lambda **kw: _RealAsyncClient(transport=httpx.MockTransport(handler), **kw),
    )
    return AuthClientReal()


# ---------- the exchange's statuses, by meaning ----------


@pytest.mark.parametrize(
    ("status", "expected"),
    [(400, AuthBadRequestError), (401, AuthKeyRejectedError), (403, AuthUserBannedError), (500, AuthTokenError)],
)
def test_each_status_raises_its_own_error(monkeypatch, status, expected):
    auth = _auth_client_answering(monkeypatch, lambda r: httpx.Response(status, json={"message": "x"}))

    with pytest.raises(expected) as raised:
        asyncio.run(auth.get_token(BSUID))

    assert type(raised.value) is expected


def test_a_500_is_not_mistaken_for_a_more_specific_refusal(monkeypatch):
    auth = _auth_client_answering(monkeypatch, lambda r: httpx.Response(500, json={"message": "Internal error"}))

    with pytest.raises(AuthTokenError) as raised:
        asyncio.run(auth.get_token(BSUID))

    assert not isinstance(raised.value, (AuthBadRequestError, AuthKeyRejectedError, AuthUserBannedError, AuthRateLimitedError))


def test_a_429_carries_how_long_to_wait(monkeypatch):
    auth = _auth_client_answering(
        monkeypatch, lambda r: httpx.Response(429, json={"message": "Too many requests"}, headers={"X-Retry-After": "420"})
    )

    with pytest.raises(AuthRateLimitedError) as raised:
        asyncio.run(auth.get_token(BSUID))

    assert raised.value.retry_after == 420


@pytest.mark.parametrize("header", [None, "soon", "0", "-5"])
def test_a_429_without_a_usable_wait_falls_back_to_a_default(monkeypatch, header):
    headers = {} if header is None else {"X-Retry-After": header}
    auth = _auth_client_answering(monkeypatch, lambda r: httpx.Response(429, json={}, headers=headers))

    with pytest.raises(AuthRateLimitedError) as raised:
        asyncio.run(auth.get_token(BSUID))

    assert raised.value.retry_after == DEFAULT_RETRY_AFTER_SECONDS


def test_a_user_with_a_spent_budget_is_not_asked_again_until_it_frees_up(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, json={}, headers={"X-Retry-After": "120"})
        return httpx.Response(200, json={"token": "jwt-after-cooldown"})

    auth = _auth_client_answering(monkeypatch, handler)
    now = [1000.0]
    monkeypatch.setattr("ansari_whatsapp.services.auth_client_real.time.monotonic", lambda: now[0])

    with pytest.raises(AuthRateLimitedError):
        asyncio.run(auth.get_token(BSUID))
    now[0] += 30
    with pytest.raises(AuthRateLimitedError) as still:
        asyncio.run(auth.get_token(BSUID))
    assert len(calls) == 1, "a cooling-down user must not reach apps/auth again"
    assert 0 < still.value.retry_after <= 91

    now[0] += 91
    assert asyncio.run(auth.get_token(BSUID)) == "jwt-after-cooldown"
    assert len(calls) == 2


def test_one_users_cooldown_does_not_affect_another(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content)["bsuid"] == BSUID:
            return httpx.Response(429, json={}, headers={"X-Retry-After": "600"})
        return httpx.Response(200, json={"token": "jwt-other"})

    auth = _auth_client_answering(monkeypatch, handler)

    with pytest.raises(AuthRateLimitedError):
        asyncio.run(auth.get_token(BSUID))

    assert asyncio.run(auth.get_token("US.99999999999999999999")) == "jwt-other"


def test_a_banned_user_is_not_cached_or_cooled_down(monkeypatch):
    answers = [httpx.Response(403, json={}), httpx.Response(200, json={"token": "jwt-unbanned"})]
    auth = _auth_client_answering(monkeypatch, lambda r: answers.pop(0))

    with pytest.raises(AuthUserBannedError):
        asyncio.run(auth.get_token(BSUID))

    assert asyncio.run(auth.get_token(BSUID)) == "jwt-unbanned"


def test_forget_drops_only_that_users_cached_token(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content)["bsuid"])
        return httpx.Response(200, json={"token": f"jwt-{len(calls)}"})

    auth = _auth_client_answering(monkeypatch, handler)
    asyncio.run(auth.get_token(BSUID))
    asyncio.run(auth.get_token("US.99999999999999999999"))

    auth.forget(BSUID)

    assert asyncio.run(auth.get_token(BSUID)) == "jwt-3"
    assert asyncio.run(auth.get_token("US.99999999999999999999")) == "jwt-2"
    assert calls == [BSUID, "US.99999999999999999999", BSUID]


# ---------- what the user and the operator are told ----------


def _manager() -> WhatsAppConversationManager:
    return WhatsAppConversationManager(
        bsuid=BSUID,
        incoming_msg_type="text",
        incoming_msg_body={"body": "hello"},
        message_id="wamid.TEST",
        message_unix_time=int(time.time()),
    )


def _capturing(monkeypatch) -> list:
    """Record every Sentry error_type tag set by the manager."""
    seen = []
    monkeypatch.setattr(
        WhatsAppConversationManager, "_capture", staticmethod(lambda error, error_type: seen.append(error_type))
    )
    return seen


def _failing_exchange(monkeypatch, error: Exception) -> None:
    async def failing(self, bsuid):
        raise error

    monkeypatch.setattr(AuthClientMock, "get_token", failing)


@pytest.mark.parametrize(
    ("error", "reported_as"),
    [
        (AuthKeyRejectedError("401"), "auth_key_rejected"),
        (AuthBadRequestError("400"), "auth_bad_request"),
        (AuthTokenError("500"), "auth_token_failure"),
    ],
)
def test_our_key_being_refused_does_not_look_like_an_outage(monkeypatch, error, reported_as):
    seen = _capturing(monkeypatch)
    _failing_exchange(monkeypatch, error)

    assert asyncio.run(_manager().authenticate_user()) is False

    assert seen == [reported_as]


@pytest.mark.parametrize("error", [AuthUserBannedError("403"), AuthRateLimitedError("429", retry_after=300)])
def test_a_banned_or_rate_limited_user_is_not_an_operator_alert(monkeypatch, error):
    seen = _capturing(monkeypatch)
    _failing_exchange(monkeypatch, error)

    assert asyncio.run(_manager().authenticate_user()) is False

    assert seen == []


def test_the_user_is_told_the_right_thing_for_each_refusal(monkeypatch):
    _capturing(monkeypatch)
    notices = {}
    for name, error in {
        "banned": AuthUserBannedError("403"),
        "limited": AuthRateLimitedError("429", retry_after=300),
        "key": AuthKeyRejectedError("401"),
        "outage": AuthTokenError("500"),
    }.items():
        _failing_exchange(monkeypatch, error)
        manager = _manager()
        asyncio.run(manager.authenticate_user())
        notices[name] = manager.auth_failure_notice

    assert notices["banned"] == BANNED_NOTICE
    assert "5 minutes" in notices["limited"]
    assert notices["key"] == SIGN_IN_FAILED_NOTICE
    assert notices["outage"] == SIGN_IN_FAILED_NOTICE
    assert len(set(notices.values())) == 3


def test_a_stale_notice_is_not_reused_for_a_later_failure(monkeypatch):
    _capturing(monkeypatch)
    manager = _manager()
    _failing_exchange(monkeypatch, AuthUserBannedError("403"))
    asyncio.run(manager.authenticate_user())
    assert manager.auth_failure_notice == BANNED_NOTICE

    _failing_exchange(monkeypatch, AuthTokenError("500"))
    asyncio.run(manager.authenticate_user())

    assert manager.auth_failure_notice == SIGN_IN_FAILED_NOTICE


# ---------- one re-exchange on an apps/api 401 ----------


def _spy_on_replies(monkeypatch) -> list:
    replies = []
    original = MetaApiServiceMock.send_message

    async def spy(self, recipient_phone, message_parts):
        replies.extend(message_parts)
        return await original(self, recipient_phone, message_parts)

    monkeypatch.setattr(MetaApiServiceMock, "send_message", spy)
    return replies


def _api_refusing_first_tokens(monkeypatch, refused: int) -> dict:
    """apps/api refuses the first `refused` chat calls with a 401, then answers."""
    state = {"chat_calls": 0, "tokens_seen": []}
    original = AnsariClientMock.process_message

    async def process_message(self, token, thread_id, message):
        state["chat_calls"] += 1
        state["tokens_seen"].append(token)
        if state["chat_calls"] <= refused:
            raise ApiUnauthorizedError("apps/api refused the user's token")
        return await original(self, token, thread_id, message)

    monkeypatch.setattr(AnsariClientMock, "process_message", process_message)
    return state


def _counting_exchanges(monkeypatch) -> list:
    tokens = []

    async def get_token(self, bsuid):
        tokens.append(bsuid)
        return f"token-{len(tokens)}"

    monkeypatch.setattr(AuthClientMock, "get_token", get_token)
    return tokens


def test_an_api_401_triggers_one_fresh_exchange_and_the_message_is_answered(monkeypatch):
    _capturing(monkeypatch)
    replies = _spy_on_replies(monkeypatch)
    exchanges = _counting_exchanges(monkeypatch)
    api = _api_refusing_first_tokens(monkeypatch, refused=1)

    asyncio.run(_manager().sign_in_and_handle_text_message())

    assert len(exchanges) == 2, "one exchange to start, one after the 401"
    assert api["tokens_seen"] == ["token-1", "token-2"], "the retry must use the fresh token"
    assert api["chat_calls"] == 2
    assert replies and not any("error" in part.lower() or "sign you in" in part for part in replies)


def test_a_second_api_401_gives_up_instead_of_looping(monkeypatch):
    seen = _capturing(monkeypatch)
    replies = _spy_on_replies(monkeypatch)
    exchanges = _counting_exchanges(monkeypatch)
    api = _api_refusing_first_tokens(monkeypatch, refused=99)

    asyncio.run(_manager().sign_in_and_handle_text_message())

    assert len(exchanges) == 2, "never a third exchange"
    assert api["chat_calls"] == 2, "never a third attempt"
    assert seen == ["api_unauthorized_after_reexchange"]
    assert len(replies) == 1 and "error occurred" in replies[0]


def test_a_banned_user_found_on_the_api_401_is_told_so_and_not_retried(monkeypatch):
    _capturing(monkeypatch)
    replies = _spy_on_replies(monkeypatch)
    api = _api_refusing_first_tokens(monkeypatch, refused=99)
    state = {"exchanges": 0}

    async def get_token(self, bsuid):
        state["exchanges"] += 1
        if state["exchanges"] == 1:
            return "token-1"
        raise AuthUserBannedError("403")

    monkeypatch.setattr(AuthClientMock, "get_token", get_token)

    asyncio.run(_manager().sign_in_and_handle_text_message())

    assert api["chat_calls"] == 1, "no retry once the exchange says the user is banned"
    assert replies == [BANNED_NOTICE]


def test_the_stale_token_is_dropped_before_the_second_exchange(monkeypatch):
    _capturing(monkeypatch)
    _spy_on_replies(monkeypatch)
    _counting_exchanges(monkeypatch)
    _api_refusing_first_tokens(monkeypatch, refused=1)
    forgotten = []
    monkeypatch.setattr(AuthClientMock, "forget", lambda self, bsuid: forgotten.append(bsuid))

    asyncio.run(_manager().sign_in_and_handle_text_message())

    assert forgotten == [BSUID]


def test_a_non_401_failure_is_not_retried(monkeypatch):
    _capturing(monkeypatch)
    _spy_on_replies(monkeypatch)
    exchanges = _counting_exchanges(monkeypatch)
    state = {"chat_calls": 0}

    async def failing(self, token, thread_id, message):
        from ansari_whatsapp.utils.exceptions import MessageProcessingError

        state["chat_calls"] += 1
        raise MessageProcessingError("apps/api is down")

    monkeypatch.setattr(AnsariClientMock, "process_message", failing)

    asyncio.run(_manager().sign_in_and_handle_text_message())

    assert state["chat_calls"] == 1
    assert len(exchanges) == 1


def test_only_a_401_from_apps_api_raises_the_unauthorized_error(monkeypatch):
    from ansari_whatsapp.services.ansari_client_real import AnsariClientReal
    from ansari_whatsapp.utils.exceptions import ThreadInfoError

    def build(status):
        monkeypatch.setattr(
            "ansari_whatsapp.services.ansari_client_real.httpx.AsyncClient",
            lambda **kw: _RealAsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(status, json={})), **kw),
        )
        return AnsariClientReal()

    with pytest.raises(ApiUnauthorizedError):
        asyncio.run(build(401).get_last_thread_info("jwt"))
    with pytest.raises(ApiUnauthorizedError):
        asyncio.run(build(401).create_thread("jwt", "t"))
    with pytest.raises(ApiUnauthorizedError):
        asyncio.run(build(401).delete_thread("jwt", "t1"))
    with pytest.raises(ApiUnauthorizedError):
        asyncio.run(build(401).process_message("jwt", "t1", "hi"))
    for status in (403, 500):
        with pytest.raises(ThreadInfoError):
            asyncio.run(build(status).get_last_thread_info("jwt"))
