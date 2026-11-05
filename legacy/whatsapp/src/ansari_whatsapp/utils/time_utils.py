# Time Utilities
"""Utilities for time-related calculations and formatting."""

from datetime import datetime, timezone

from loguru import logger

from ansari_whatsapp.utils.config import get_settings


def format_time_delta(seconds: float) -> str:
    """Format a time delta in seconds to a human-readable string.

    Args:
        seconds (float): Time delta in seconds

    Returns:
        str: Formatted string (e.g., "5.2 seconds", "3.1 minutes", "2.5 hours", "1.2 days")
    """
    if seconds < 60:
        return f"{seconds:.1f} seconds"
    elif seconds < 3600:
        return f"{seconds / 60:.1f} minutes"
    elif seconds < 86400:
        return f"{seconds / 3600:.1f} hours"
    else:
        return f"{seconds / 86400:.1f} days"


def calculate_time_passed(last_message_time: datetime | None) -> tuple[float, str]:
    """Calculate the time passed since the last message.

    Args:
        last_message_time (datetime | None): The timestamp of the last message.

    Returns:
        tuple[float, str]: The time passed in seconds and a formatted string for logging.
    """
    if last_message_time is None:
        passed_time = float("inf")
    else:
        passed_time = (datetime.now(timezone.utc) - last_message_time).total_seconds()

    # Format for logging (compact version)
    if passed_time < 60:
        passed_time_logging = f"{passed_time:.1f}sec"
    elif passed_time < 3600:
        passed_time_logging = f"{passed_time / 60:.1f}mins"
    elif passed_time < 86400:
        passed_time_logging = f"{passed_time / 3600:.1f}hours"
    else:
        passed_time_logging = f"{passed_time / 86400:.1f}days"

    return passed_time, passed_time_logging


def get_retention_time_seconds() -> int:
    """Get the WhatsApp chat retention time in seconds from settings.

    Returns:
        int: The retention time in seconds.
    """
    settings = get_settings()
    retention_hours = settings.WHATSAPP_CHAT_RETENTION_HOURS
    return retention_hours * 60 * 60


def is_message_too_old(message_unix_time: int | None) -> bool:
    """Check if an incoming message is older than the allowed threshold.

    Uses the message timestamp (Unix time format - seconds since epoch)
    to determine if the message is too old to process.

    Args:
        message_unix_time (int | None): The message timestamp in Unix time format.

    Returns:
        bool: True if the message is older than the threshold, False otherwise
    """
    settings = get_settings()
    too_old_threshold = settings.WHATSAPP_MESSAGE_AGE_THRESHOLD_SECONDS

    # If there's no timestamp, message can't be verified as too old
    if not message_unix_time:
        logger.debug("No timestamp available, cannot determine message age")
        return False

    # Convert the Unix timestamp to a datetime object
    try:
        msg_time = datetime.fromtimestamp(message_unix_time, tz=timezone.utc)
        # Get the current time in UTC
        current_time = datetime.now(timezone.utc)
        # Calculate time difference in seconds
        time_diff = (current_time - msg_time).total_seconds()

        # Log the message age for debugging
        age_logging = format_time_delta(time_diff)
        logger.debug(f"Message age: {age_logging}")

        # Return True if the message is older than the threshold
        return time_diff > too_old_threshold

    except (ValueError, TypeError) as e:
        logger.error(f"Error parsing message timestamp: {e}")
        return False
