# WhatsApp Logger for ansari-whatsapp
"""Logging configuration for the WhatsApp service using Loguru.

Technical Details:
- Module Execution: Importing this file multiple times will execute its code only once.
  Python modules are singletons. Therefore, it's fine to import this module in any other
    module that needs logging functionality.
  Proof: https://docs.python.org/3/tutorial/modules.html#more-on-modules

- Loguru Instance: The `logger` object is a singleton. Once configured here, the same
  instance is used throughout the application wherever `from ansari_whatsapp.utils.app_logger import logger` is used.
  Proof: https://github.com/Delgan/loguru/issues/54#issuecomment-461724397

- Side Effects on Import: This module configures the global logger immediately upon import.
  This is a deliberate design choice to ensure consistent logging across the application,
  including during tests. Developers should be aware that simply importing this module
  will modify the global logging state.

Railway: outside local development, every log line is one JSON object on stdout, which Railway parses into
searchable fields (https://docs.railway.com/guides/logs#structured-logs). To find everything one message did:
search `@request_id:<id>` in the log explorer (the id is also returned to the caller as the `X-Request-ID` header).
"""

import contextvars
import json
import os
import sys

from loguru import logger

from ansari_whatsapp.utils.config import get_settings

########################################## Context Variables ##########################################

# Context variable for log correlation: one id per incoming HTTP request.
# It automatically propagates to child async tasks (including FastAPI's BackgroundTasks).
request_id_var = contextvars.ContextVar("request_id", default="none")

########################################## Global Vars and Logger Configurations ##########################################

# Remove any pre-existing default handlers made by loguru
logger.remove()

# Get settings
settings = get_settings()


def should_use_json_logs(deployment_type: str, github_actions: str | None) -> bool:
    """JSON lines everywhere except local development and GitHub Actions."""
    return deployment_type not in ["local", "development"] and github_actions != "true"


use_json_logs = should_use_json_logs(settings.DEPLOYMENT_TYPE, os.getenv("GITHUB_ACTIONS"))

# Railway understands debug/info/warn/error, so Loguru's other levels are mapped onto those
RAILWAY_LEVELS = {"TRACE": "debug", "DEBUG": "debug", "INFO": "info", "SUCCESS": "info", "WARNING": "warn"}

########################################## Functions ##########################################


def log_record_preprocessor(record):
    """Preprocess log records before formatting: inject context and apply filters.

    This function runs before Loguru formats the log record and sends it to sink, and it serves two purposes:
    1. Inject request_id from its contextvar into record["extra"]
    2. Filter logs based on LOG_TEST_FILES_ONLY setting

    Args:
        record: The log record being processed.

    Returns:
        bool: True to keep the log, False to discard it.
    """
    # Step 1: Inject context from contextvars
    record["extra"]["request_id"] = request_id_var.get()

    # Step 2: Apply filtering logic
    if settings.LOG_TEST_FILES_ONLY and not ("tests" in record["file"].path or "test_" in record["file"].name):
        return False

    return True


def build_log_entry(record) -> dict:
    """Turn a Loguru record into the JSON object Railway expects.

    `message` and `level` are the two keys Railway reads; every other key becomes a field you can search with
    `@name:value`. Railway adds the timestamp itself, so none is included.
    """
    entry = {
        "level": RAILWAY_LEVELS.get(record["level"].name, "error"),
        "message": record["message"],
        "request_id": record["extra"].get("request_id"),
        "file": record["file"].name,
        "line": record["line"],
        "function": record["function"],
    }

    if record["exception"]:
        exc = record["exception"]
        entry["exception"] = {
            "type": exc.type.__name__ if exc.type else None,
            "value": str(exc.value) if exc.value else None,
        }

    return entry


def railway_json_sink(message):
    """Write one log line as a single-line JSON object to stdout.

    It must be stdout: Railway marks everything written to stderr as an error, however the JSON says otherwise.
    The whole object must stay on one line, or Railway cannot parse it.
    """
    sys.stdout.write(json.dumps(build_log_entry(message.record)) + "\n")
    sys.stdout.flush()


########################################## Main Code ##########################################

if use_json_logs:
    log_sink = railway_json_sink
    # The sink builds the JSON itself from the raw record, so Loguru's own formatting is kept minimal
    log_format = "{message}"
    enable_colors = False
else:
    # Readable lines on stderr for local development
    log_sink = sys.stderr
    log_format = (
        "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
        "<level>{level: <4}</level> | "
        "<cyan>{file}</cyan>:<cyan>{line}</cyan> "
        "<blue>[{function}()]</blue> | "
        "<level>{message}</level> | "
        # To see the request id in local logs too, uncomment the line below.
        # "req:{extra[request_id]}"
    )
    enable_colors = True

logger.add(
    log_sink,
    format=log_format,
    level=settings.LOGGING_LEVEL.upper(),
    enqueue=True,
    colorize=enable_colors,
    backtrace=False,
    diagnose=False,
    filter=log_record_preprocessor,
    catch=False,
)
