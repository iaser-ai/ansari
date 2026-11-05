"""The Meta sender must not write Meta's error body to the logs (spec 321, phase 4 review)."""

import asyncio

import httpx
import pytest
from loguru import logger

from ansari_whatsapp.services.meta_api_service_real import MetaApiServiceReal

BSUID = "US.13491208655302741918"
ECHOED_BODY = '{"error":{"message":"Recipient US.13491208655302741918 is not allowed"}}'

_RealAsyncClient = httpx.AsyncClient


def _failing_meta(monkeypatch):
    monkeypatch.setattr(
        "ansari_whatsapp.services.meta_api_service_real.httpx.AsyncClient",
        lambda **kw: _RealAsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(400, text=ECHOED_BODY)), **kw),
    )


@pytest.mark.parametrize("method", ["send_message", "send_typing_indicator"])
def test_a_failed_send_logs_the_status_but_never_meta_error_body(monkeypatch, method):
    _failing_meta(monkeypatch)
    service = MetaApiServiceReal()
    captured = []
    sink_id = logger.add(lambda m: captured.append(str(m)), level="DEBUG")
    try:
        with pytest.raises(httpx.HTTPStatusError):
            if method == "send_message":
                asyncio.run(service.send_message(BSUID, ["hello"]))
            else:
                asyncio.run(service.send_typing_indicator(BSUID, "wamid.T"))
    finally:
        logger.remove(sink_id)

    log_text = "\n".join(captured)
    assert "400" in log_text
    assert BSUID not in log_text
    assert "is not allowed" not in log_text
