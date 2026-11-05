"""Tests for the Railway-style JSON logs (spec 321, phase 4)."""

import json
from types import SimpleNamespace

import pytest

from ansari_whatsapp.utils.app_logger import build_log_entry, railway_json_sink, request_id_var, should_use_json_logs


def _record(level: str = "INFO", message: str = "hello", exception=None) -> dict:
    return {
        "level": SimpleNamespace(name=level),
        "message": message,
        "extra": {"request_id": "req-123"},
        "file": SimpleNamespace(name="main.py"),
        "line": 42,
        "function": "handler",
        "exception": exception,
    }


def test_entry_has_the_message_and_level_keys_railway_reads():
    entry = build_log_entry(_record(message="Created a new thread"))

    assert entry["message"] == "Created a new thread"
    assert entry["level"] == "info"


def test_entry_carries_the_request_id_as_a_searchable_field():
    assert build_log_entry(_record())["request_id"] == "req-123"


def test_entry_has_no_user_id_field():
    assert "user_id" not in build_log_entry(_record())


@pytest.mark.parametrize(
    ("loguru_level", "railway_level"),
    [
        ("TRACE", "debug"),
        ("DEBUG", "debug"),
        ("INFO", "info"),
        ("SUCCESS", "info"),
        ("WARNING", "warn"),
        ("ERROR", "error"),
        ("CRITICAL", "error"),
    ],
)
def test_levels_are_mapped_to_the_four_railway_understands(loguru_level, railway_level):
    assert build_log_entry(_record(level=loguru_level))["level"] == railway_level


def test_exception_details_are_included_as_type_and_value():
    exc = SimpleNamespace(type=ValueError, value=ValueError("bad"))

    assert build_log_entry(_record(level="ERROR", exception=exc))["exception"] == {"type": "ValueError", "value": "bad"}


def test_sink_writes_one_json_object_on_one_line_to_stdout(monkeypatch, capsys):
    railway_json_sink(SimpleNamespace(record=_record(message="line one\nline two")))

    captured = capsys.readouterr()
    assert captured.err == ""  # stderr would make Railway show it as an error
    assert captured.out.count("\n") == 1  # an embedded newline is escaped inside the JSON, not a second line
    assert json.loads(captured.out)["message"] == "line one\nline two"


def test_request_id_variable_defaults_to_none_outside_a_request():
    assert request_id_var.get() == "none"


@pytest.mark.parametrize(
    ("deployment_type", "github_actions", "expected"),
    [
        ("local", None, False),
        ("development", None, False),
        ("staging", None, True),
        ("production", None, True),
        ("staging", "true", False),  # CI never emits JSON, whatever the deployment type
        ("production", "false", True),
    ],
)
def test_json_logs_are_used_only_when_deployed_and_not_in_ci(deployment_type, github_actions, expected):
    assert should_use_json_logs(deployment_type, github_actions) is expected
