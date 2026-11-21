"""Regenerate `pythonOracle.ts` from the legacy Python service (issue #358, plan phase 2).

Why this exists: the Python test suite covers the message splitter well, but barely touches the markdown
formatter, the time helpers or the webhook parser. So that "the TypeScript port behaves like Python" is checked
rather than assumed, this script runs the legacy code on a table of inputs and writes the answers into a TypeScript
module that the Vitest tests import. The expected values in `pythonOracle.ts` are therefore Python's real output,
including its quirks (they are kept on purpose; see the comments in the TypeScript tests).

Run from the repo root, with a Python that has the legacy service's dependencies (the `legacy/whatsapp` uv env):

    cd legacy/whatsapp
    uv run python ../../apps/whatsapp/tests/fixtures/generate_python_oracle.py ../../apps/whatsapp/tests/fixtures/pythonOracle.ts

It never talks to the network. Delete this file together with `legacy/whatsapp` once the Python service is gone;
`pythonOracle.ts` stays valid because it is plain data.
"""

import asyncio
import copy
import datetime as _dt
import hashlib
import json
import math
import os
import sys
import types

# Dummy credentials, as in legacy/whatsapp/tests/conftest.py. Nothing here is a real secret.
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
    "MOCK_AUTH_TOKEN": "",
}.items():
    os.environ[key] = value

from loguru import logger  # noqa: E402

from ansari_whatsapp.presenters.whatsapp_message_formatter import (  # noqa: E402
    convert_bold_syntax,
    convert_headers,
    convert_italic_syntax,
    format_for_whatsapp,
    format_nested_lists,
)
from ansari_whatsapp.services.whatsapp_conversation_manager import (  # noqa: E402
    WhatsAppConversationManager,
    _rate_limited_notice,
)
from ansari_whatsapp.utils.config import get_settings  # noqa: E402
from ansari_whatsapp.utils.exceptions import UnexpectedMetaPayloadError  # noqa: E402
from ansari_whatsapp.utils.language_utils import get_language_direction_from_text  # noqa: E402
from ansari_whatsapp.utils import time_utils  # noqa: E402
from ansari_whatsapp.utils.time_utils import calculate_time_passed, format_time_delta, is_message_too_old  # noqa: E402
from ansari_whatsapp.utils.whatsapp_message_splitter import split_message  # noqa: E402
from ansari_whatsapp.utils.whatsapp_webhook_utils import parse_meta_payload  # noqa: E402

logger.remove()  # the parser logs the payloads it rejects; keep this script quiet

# A frozen clock, so "how old is this message" has one answer. The TypeScript tests pass the same instant in.
FIXED_NOW = _dt.datetime(2026, 11, 10, 12, 0, 0, tzinfo=_dt.timezone.utc)
FIXED_NOW_UNIX = int(FIXED_NOW.timestamp())


class _FrozenDatetime(_dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_NOW


time_utils.datetime = _FrozenDatetime

AR = "\u0645\u0631\u062d\u0628\u0627"  # an Arabic word, written as escapes so this file stays ASCII
BSUID = "US.13491208655302741918"
PHONE_ID = "123456789"

# ---------------------------------------------------------------------------------------------------------------------
# Formatter
# ---------------------------------------------------------------------------------------------------------------------

FORMATTER_INPUTS = [
    "plain text",
    "Hello **bold** world",
    "Hello *italic* world",
    "Mix **bold** and *italic* together",
    "***both***",
    "***bold italic***",
    "***\ntext\n***",
    "a *b c* d",
    "1 * 2 * 3 and *real*",
    "***a*** and **b** and *c*",
    "**bold with *italic* inside**",
    "* a\n* b\n* c",
    "_*mixed*_",
    "**a** and **b**",
    "*a*b*c*",
    "*a\nb*",
    "snake_case and *it_alic* here",
    "a * b * c",
    "2 * 3 = 6 and 4 * 5 = 20",
    "## Title\n\nBody text",
    "## Title\nBody text right after",
    "# Big\n\n## Medium\n\n### Small\n\nEnd",
    "## **Bold header**\n\nText",
    "## _Italic header_\n\nText",
    "Text before\n\n## Header\n\nText after",
    "text ## inline header\nnext line",
    "## H1\n## H2\n\nbody",
    "## \nempty header text",
    "#hashtag not a header",
    "1. one\n2. two\n3. three",
    "- a\n- b\n- c",
    "* a\n* b",
    "1. one\n   - nested a\n   - nested b\n2. two",
    "- bullet\n  1. nested one\n  2. nested two\n- bullet two",
    "- a\n  - b\n    - c\n- d",
    "1. a\n   1. b\n   2. c\n2. d",
    "* a\n  * b\n  * c",
    "- a\n  * b\n  * c",
    "  - indented first\n  - indented second",
    "- a\n    - deep\n  - mid\n- back",
    "- item\n\n  - after blank\n- end",
    "- a - b - c\n  - d - e",
    "1. x 2. y\n   3. z 4. w",
    "tabs\there\n\t- tab nested\n\t- tab nested 2",
    "\u00a0\u00a0- nbsp nested\n\u2003- emsp nested",
    "**unclosed bold",
    "*unclosed italic",
    "line one\r\nline two\r\n## Header\r\n\r\nbody",
    "- a\r\n  - b\r\n- c",
    "emoji \U0001f600 **bold** \U0001f600",
    # Arabic (right-to-left) text goes through the list formatter; Python's \d also matches Arabic-Indic digits
    AR + " **" + AR + "** " + AR,
    "## \u0639\u0646\u0648\u0627\u0646\n\n\u0646\u0635",
    "\u0627\u0644\u0646\u0642\u0627\u0637:\n1. \u0623\u0648\u0644\n   - \u0641\u0631\u0639\u064a\n2. \u062b\u0627\u0646\u064a",
    "\u0661. \u0623\u0648\u0644\n   \u0662. \u0641\u0631\u0639\u064a\n\u0662. \u062b\u0627\u0646\u064a",
    "- " + AR + "\n  \u0661. " + AR + "\n  \u0662. " + AR,
    "Mostly English with " + AR,
    AR + AR + " mostly english text here to push the RTL share under the threshold, so lists stay as they are",
]

ITALIC_INPUTS = ["*a*", "**a**", "*a* and *b*", "_*a*_", "*a b c*", "*a_b*", "x*y*z", "*", "**", "* a *", "*a\n*"]
BOLD_INPUTS = ["**a**", "**a** **b**", "***a***", "*a*", "****", "**", "*"]
HEADER_INPUTS = [
    "# H\nbody",
    "# H\n\nbody",
    "## H\n\n\nbody",
    "### *_H_*\nx",
    "text\n# H\n",
    "# H",
    "#### deep\nx",
    "#nospace\nx",
    "# H\r\nbody",
    "# H\r\n\r\nbody",
]
NESTED_INPUTS = [
    "- a\n  - b",
    "1. a\n  2. b",
    "  * a",
    "- a\n  - b\n- c\n  - d",
    "text\n  - a",
    "- a\n\n  - b",
    "\u0661. a\n  \u0662. b",
    "  - a - b",
    "  1. a 2. b",
]

# One bold-or-italic marker per case would hide Unicode bugs, so the direction cases lean on Arabic and emoji.
# 4 right-to-left characters out of 12 code points is 33% (RTL); counted as UTF-16 units it would be 20% (LTR).
DIRECTION_INPUTS = [
    "hello",
    AR,
    "ab " + AR,
    AR + " a",
    "  ",
    "12345",
    "\u0645" * 3 + "a" * 7,
    "\u0645" * 4 + "a" * 6,
    "\u0645" * 31 + "a" * 69,
    "\u0645" * 30 + "a" * 70,
    "\u0645" * 300 + "a" * 700,
    "\ufb50\ufb51 test",
    "\u0750\u0751\u0752 x",
    "\u08a0\u08a1 x",
    "\u0645\u0631\u062d\u0628" + "\U0001f600" * 8,
    "\u0645\u0631\u062d\u0628" + "\U0001f600" * 12,
]

TIME_DELTA_INPUTS = [0, 0.04, 0.05, 0.25, 1, 5.25, 5.35, 59.94, 59.95, 59.99, 60, 61.5, 90, 3599, 3599.99, 3600, 5400,
                     86399, 86400, 129600, 1e9]

# Seconds since the last message; None means "never". Negative means a message from the future.
TIME_PASSED_INPUTS = [None, 0, 0.25, 5.25, 59.94, 59.95, 60, 90, 3599.99, 3600, 5400, 86399, 86400, 129600, 1e7, -30]


def _num(x: float):
    """JSON has no infinity; spell it the way the TypeScript test reads it."""
    return "inf" if math.isinf(x) else x


def time_passed_case(seconds_ago):
    last = None if seconds_ago is None else FIXED_NOW - _dt.timedelta(seconds=seconds_ago)
    passed, logging_text = calculate_time_passed(last)
    return [seconds_ago, _num(passed), logging_text]


# Message ages are given as seconds before FIXED_NOW (the retention threshold is the default, 86400).
# Timestamps beyond year 9999 are deliberately NOT here: CPython raises ValueError on Linux (caught, so "not too
# old") but OSError on Windows (not caught, so the call crashes), so this machine cannot give Railway's answer.
# The TypeScript tests cover that case on their own and say so.
MESSAGE_AGE_INPUTS = [None, 0, 100, 86399, 86400, 86401, -3600]


def message_age_case(age):
    unix = None if age is None else FIXED_NOW_UNIX - age
    return [age, unix, is_message_too_old(unix)]


# Values the services print with !r or inside an f-string of a list or dict (the Meta error summary and payload keys).
# JSON-shaped, so the same value can be written on both sides.
REPR_INPUTS = [
    "plain",
    "it's",
    'say "hi"',
    "it's \"both\"",
    "line\nbreak",
    "tab\there",
    "back\\slash",
    "",
    " ",
    "carriage\rreturn",
    "\u00e9 accent",
    "\u0645\u0631\u062d\u0628\u0627",
    "\U0001f600 emoji",
    "nul\x00byte",
    "del\x7fchar",
    "zero\u200bwidth",
    "no\u00a0break space",
    "line\u2028separator",
    131030,
    -5,
    0,
    1.5,
    True,
    False,
    None,
    [],
    ["a", "b"],
    ["it's", 1, None],
    {},
    {"k": "v"},
    {"a": [1, "x"], "it's": {"n": None}},
]


# ---------------------------------------------------------------------------------------------------------------------
# Conversation manager: the notices that depend on an input, and the thread title
# ---------------------------------------------------------------------------------------------------------------------

RETRY_AFTER_INPUTS = [-5, 0, 1, 59, 60, 61, 119, 120, 121, 300, 899, 900, 3599, 3600, 86400]

# What Meta calls the type of a message that is not text. "errors" is what the parser reports for an unsupported one;
# "unsupported" (with the replace in handle_unsupported_message) is kept to show that branch.
MEDIA_TYPE_INPUTS = [
    "image", "audio", "video", "sticker", "document", "location", "contacts", "reaction", "interactive", "button",
    "order", "system", "errors", "unsupported", "images", "text", "s", "Image", "",
]

THREAD_TITLE_INPUTS = [
    "",
    "   ",
    "hello",
    "what is ansari",
    "one two three four five six seven eight nine",
    "one two three four five six",
    "one two three four five six seven",
    "  lead and   trail  ",
    "tab\there\nnew\r\nline",
    "no\u00a0break\u2003em\u3000ideographic space",
    "line\u2028separator\u2029paragraph",
    "c0\x1cfile\x1dgroup\x1erecord\x1funit\x85next",
    "\ufeffbom is not whitespace",
    "zero\u200bwidth stays",
    "\u0645\u0631\u062d\u0628\u0627 \u0643\u064a\u0641 \u062d\u0627\u0644\u0643 \u064a\u0627 \u0623\u062e\u064a \u0627\u0644\u0643\u0631\u064a\u0645 \u0623\u0631\u064a\u062f \u0627\u0644\u0633\u0624\u0627\u0644",
    "\U0001f600 emoji \U0001f600 words",
    "x" * 500,
]


def _manager(message_type: str = "text") -> WhatsAppConversationManager:
    return WhatsAppConversationManager(
        bsuid=BSUID, incoming_msg_type=message_type, incoming_msg_body={}, message_id="wamid.ORACLE"
    )


def unsupported_notice_case(message_type: str):
    """What the user is sent for a message of this type (nothing at all when the type is empty)."""
    sent = []
    manager = _manager(message_type)

    async def capture(msg_body, recipient_bsuid_or_phone=None):
        sent.append(msg_body)

    manager.send_whatsapp_message = capture
    asyncio.run(manager.handle_unsupported_message())
    return [message_type, sent]


def thread_title_case(first_message: str):
    """The title the manager gives a new thread, taken from the real _resolve_thread."""
    titles = []
    manager = _manager()
    manager.token = "oracle-token"

    async def no_thread_yet(token):
        return {"thread_id": None, "last_message_time": None}

    async def create_thread(token, title):
        titles.append(title)
        return {"thread_id": "t1"}

    manager.ansari_client = types.SimpleNamespace(get_last_thread_info=no_thread_yet, create_thread=create_thread)
    asyncio.run(manager._resolve_thread(first_message))
    return [first_message, titles[0]]


# ---------------------------------------------------------------------------------------------------------------------
# Splitter: inputs are described by a recipe both languages can rebuild; the expected answer is a summary
# ---------------------------------------------------------------------------------------------------------------------

LIMIT = 4000


def _paragraphs(count: int, size: int = 500) -> str:
    return "\n\n".join(f"{i:03d} " + "w" * (size - 4) for i in range(count))


URL = "https://example.org/" + "u" * 200
BOLD = "*" + "b" * 100 + "*"
SECTION = "*_Title_*\n" + "x" * 2500

SPLITTER_RECIPES = {
    "short": "hello",
    "exactly_the_limit": "a" * LIMIT,
    "one_over_the_limit_without_spaces": "a" * (LIMIT + 1),
    "thirty_paragraphs": _paragraphs(30),
    "giant_unbroken": "".join(chr(97 + i % 26) for i in range(LIMIT * 2 + 123)),
    "three_header_sections": "\n\n".join([SECTION, SECTION, SECTION]),
    "long_prefix_then_headers": "\n\n".join(["q" * 1500] * 4) + "\n\n*_H1_*\n" + "x" * 100 + "\n\n*_H2_*\n" + "y" * 100,
    "header_section_too_long": "*_A_*\n" + "z" * 4500 + "\n\n*_B_*\n" + "z" * 100,
    "bold_sections": "\n\n".join(f"*Item {i}* " + "word " * 700 for i in range(4)),
    "long_bold_phrase": "\n\n".join([BOLD + " " + "a" * 3500, BOLD + " " + "c" * 3500]),
    "url_at_the_boundary": "a" * (LIMIT - 50) + " " + URL + " " + "z" * 500,
    "words_without_paragraphs": "lorem ipsum dolor " * 600,
    "lines_without_blank_lines": "line of text\n" * 400,
    "emoji_only_over_the_limit": "\U0001f600" * (LIMIT + 1),
    "emoji_at_the_boundary": "a" * (LIMIT - 1) + "\U0001f600" * 3,
    "emoji_and_spaces": "\U0001f600 " * 3000,
    # 1500 emoji is 1500 code points but 3000 UTF-16 units: two such paragraphs pack together only when counted the
    # way Python counts (1500 + 1500 + 2 <= 4000)
    "emoji_paragraphs": "\n\n".join(["\U0001f600" * 1500] * 3),
    "arabic_words": "\u0643\u0644\u0645\u0629 " * 2000,
    "one_paragraph_too_long_in_the_middle": "short\n\n" + "x" * 4500 + "\n\nshort two",
    "several_blank_lines": "a" * 2000 + "\n\n\n\n" + "b" * 2500,
    # Python returns NO chunks for an answer that is only newlines (the split leaves one empty paragraph)
    "only_newlines": "\n" * 5000,
    "only_spaces": " " * 4001,
}


def summarise(chunks: list[str]) -> dict:
    return {
        "count": len(chunks),
        "lengths": [len(c) for c in chunks],  # code points, the way Python counts
        "sha256": hashlib.sha256("\x00".join(chunks).encode("utf-8")).hexdigest(),
    }


# ---------------------------------------------------------------------------------------------------------------------
# Webhook parser
# ---------------------------------------------------------------------------------------------------------------------


def meta(phone_id: str = PHONE_ID) -> dict:
    return {"phone_number_id": phone_id, "display_phone_number": "+1234567890"}


def payload(value) -> dict:
    return {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}


def text_message(**extra) -> dict:
    msg = {"from_user_id": BSUID, "id": "wamid.TEST", "timestamp": "1700000000", "type": "text", "text": {"body": "hello"}}
    msg.update(extra)
    return msg


def without(msg: dict, *keys: str) -> dict:
    return {k: v for k, v in msg.items() if k not in keys}


PARSER_CASES = [
    # (name, payload, META_REPLY_BY_PHONE)
    ("text message", payload({"metadata": meta(), "messages": [text_message()]}), False),
    ("sender phone ignored when replies by phone are off", payload({"metadata": meta(), "messages": [text_message(**{"from": "201234567899"})]}), False),
    ("sender phone read when replies by phone are on", payload({"metadata": meta(), "messages": [text_message(**{"from": "201234567899"})]}), True),
    ("replies by phone on but no sender phone", payload({"metadata": meta(), "messages": [text_message()]}), True),
    ("status update", payload({"metadata": meta(), "statuses": [{"id": "wamid.S", "status": "delivered"}]}), False),
    ("another business number", payload({"metadata": meta("999"), "messages": [text_message()]}), False),
    ("status for another business number", payload({"metadata": meta("999"), "statuses": [{"id": "x"}]}), False),
    ("unsupported message type", payload({"metadata": meta(), "messages": [{"from_user_id": BSUID, "id": "wamid.U", "timestamp": "1700000000", "type": "unsupported", "errors": [{"code": 131051, "title": "Message type is not supported"}]}]}), False),
    ("image message", payload({"metadata": meta(), "messages": [{"from_user_id": BSUID, "id": "wamid.I", "timestamp": "1700000000", "type": "image", "image": {"id": "1", "mime_type": "image/jpeg"}}]}), False),
    ("no timestamp", payload({"metadata": meta(), "messages": [without(text_message(), "timestamp")]}), False),
    ("timestamp as a number", payload({"metadata": meta(), "messages": [text_message(timestamp=1700000000)]}), False),
    ("timestamp that is not a number", payload({"metadata": meta(), "messages": [text_message(timestamp="abc")]}), False),
    ("missing from_user_id, contact has user_id", payload({"metadata": meta(), "messages": [without(text_message(), "from_user_id")], "contacts": [{"user_id": "US.999"}]}), False),
    ("missing from_user_id, no contacts", payload({"metadata": meta(), "messages": [without(text_message(), "from_user_id")]}), False),
    ("missing type", payload({"metadata": meta(), "messages": [without(text_message(), "type")]}), False),
    ("declared type has no matching key and no errors key", payload({"metadata": meta(), "messages": [without(text_message(), "text")]}), False),
    ("declared type that is an object property name", payload({"metadata": meta(), "messages": [text_message(type="constructor")]}), False),
    ("empty body", {}, False),
    ("no object key", {"entry": [{"changes": [{"value": {"metadata": meta(), "messages": [text_message()]}}]}]}, False),
    ("empty entry list", {"object": "whatsapp_business_account", "entry": []}, False),
    ("empty changes list", {"object": "whatsapp_business_account", "entry": [{"changes": []}]}, False),
    ("empty value", payload({}), False),
    ("no metadata", payload({"messages": [text_message()]}), False),
    ("no phone_number_id in metadata", payload({"metadata": {"display_phone_number": "+1"}, "messages": [text_message()]}), False),
    ("neither messages nor statuses", payload({"metadata": meta()}), False),
    ("empty messages list", payload({"metadata": meta(), "messages": []}), False),
    ("only the first entry is read", {"object": "whatsapp_business_account", "entry": [
        {"changes": [{"value": {"metadata": meta(), "messages": [text_message()]}}]}, "garbage"]}, False),
]


def run_parser(body: dict, reply_by_phone: bool) -> dict:
    get_settings().META_REPLY_BY_PHONE = reply_by_phone
    try:
        result = asyncio.run(parse_meta_payload(copy.deepcopy(body)))
    except UnexpectedMetaPayloadError as e:
        return {"error": "unexpected_payload", "pythonClass": type(e).__name__, "replyTo": e.reply_to, "message": str(e)}
    except Exception as e:  # noqa: BLE001 - main.py also catches everything else the same way
        return {"error": "invalid_payload", "pythonClass": type(e).__name__}
    is_status, is_target, bsuid, msg_type, msg_body, msg_id, unix_time, sender_phone = result
    if not is_target:
        return {"kind": "other_number"}
    if is_status:
        return {"kind": "status"}
    return {
        "kind": "message",
        "bsuid": bsuid,
        "messageType": msg_type,
        "messageBody": msg_body,
        "messageId": msg_id,
        "messageUnixTime": unix_time,
        "senderPhone": sender_phone,
    }


def expect_error(fn, *args) -> str:
    try:
        fn(*args)
    except Exception as e:  # noqa: BLE001
        return type(e).__name__
    return "no error"


def main(out_path: str) -> None:
    data = {
        "FORMATTER_CASES": [[t, format_for_whatsapp(t)] for t in FORMATTER_INPUTS],
        "ITALIC_CASES": [[t, convert_italic_syntax(t)] for t in ITALIC_INPUTS],
        "BOLD_CASES": [[t, convert_bold_syntax(t)] for t in BOLD_INPUTS],
        "HEADER_CASES": [[t, convert_headers(t)] for t in HEADER_INPUTS],
        "NESTED_LIST_CASES": [[t, format_nested_lists(t)] for t in NESTED_INPUTS],
        "DIRECTION_CASES": [[t, get_language_direction_from_text(t)] for t in DIRECTION_INPUTS],
        "REPR_CASES": [[value, repr(value)] for value in REPR_INPUTS],
        "TIME_DELTA_CASES": [[s, format_time_delta(s)] for s in TIME_DELTA_INPUTS],
        "TIME_PASSED_CASES": [time_passed_case(s) for s in TIME_PASSED_INPUTS],
        "MESSAGE_AGE_CASES": [message_age_case(a) for a in MESSAGE_AGE_INPUTS],
        "RATE_LIMITED_NOTICE_CASES": [[s, _rate_limited_notice(s)] for s in RETRY_AFTER_INPUTS],
        "UNSUPPORTED_NOTICE_CASES": [unsupported_notice_case(t) for t in MEDIA_TYPE_INPUTS],
        "THREAD_TITLE_CASES": [thread_title_case(t) for t in THREAD_TITLE_INPUTS],
        # Every code point str.split() treats as a separator: the thread title is cut at these.
        "PYTHON_WHITESPACE": [i for i in range(0x110000) if chr(i).isspace()],
        "SPLITTER_CASES": {name: summarise(split_message(text)) for name, text in SPLITTER_RECIPES.items()},
        "PARSER_CASES": [
            {"name": name, "replyByPhone": by_phone, "payload": body, "expected": run_parser(body, by_phone)}
            for name, body, by_phone in PARSER_CASES
        ],
        # Python crashes on the empty string (ZeroDivisionError). Nothing can send one: the callers check first.
        "EMPTY_TEXT": {
            "direction": expect_error(get_language_direction_from_text, ""),
            "format": expect_error(format_for_whatsapp, ""),
        },
    }

    types = {
        "FORMATTER_CASES": "Cases",
        "ITALIC_CASES": "Cases",
        "BOLD_CASES": "Cases",
        "HEADER_CASES": "Cases",
        "NESTED_LIST_CASES": "Cases",
        "DIRECTION_CASES": "Cases",
        "REPR_CASES": "Array<[value: unknown, python: string]>",
        "TIME_DELTA_CASES": "Array<[seconds: number, formatted: string]>",
        "TIME_PASSED_CASES": "Array<[secondsAgo: number | null, passed: number | 'inf', logging: string]>",
        "MESSAGE_AGE_CASES": "Array<[secondsAgo: number | null, unixTime: number | null, tooOld: boolean]>",
        "RATE_LIMITED_NOTICE_CASES": "Array<[retryAfterSeconds: number, notice: string]>",
        "UNSUPPORTED_NOTICE_CASES": "Array<[messageType: string, sent: string[]]>",
        "THREAD_TITLE_CASES": "Cases",
        "PYTHON_WHITESPACE": "number[]",
        "SPLITTER_CASES": "Record<string, SplitSummary>",
        "PARSER_CASES": "ParserCase[]",
        "EMPTY_TEXT": "{ direction: string; format: string }",
    }

    lines = [
        f"// Frozen clock used for the time cases: unix {FIXED_NOW_UNIX} ({FIXED_NOW.isoformat()}).",
        "// GENERATED by tests/fixtures/generate_python_oracle.py from legacy/whatsapp. Do not edit by hand.",
        "// Every expected value below is what the legacy Python service returned, quirks included.",
        "// Regenerate with the command in the script's docstring.",
        "",
        "/** [input, what Python produced]. Mutable tuples, because Vitest's it.each does not accept readonly ones. */",
        "type Cases = Array<[input: string, expected: string]>;",
        "",
        "/** Chunk count, each chunk's length in code points (how Python counts), and a hash of the chunks joined by NUL. */",
        "export interface SplitSummary {",
        "  count: number;",
        "  lengths: number[];",
        "  sha256: string;",
        "}",
        "",
        f"export const FIXED_NOW_UNIX = {FIXED_NOW_UNIX};",
        "",
        "export interface ParserCase {",
        "  name: string;",
        "  replyByPhone: boolean;",
        "  payload: unknown;",
        "  expected: Record<string, unknown>;",
        "}",
        "",
    ]
    for name, body in data.items():
        lines.append(f"export const {name}: {types[name]} = {json.dumps(body, ensure_ascii=True, indent=2)};")
        lines.append("")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print("wrote", out_path)


if __name__ == "__main__":
    main(sys.argv[1])
