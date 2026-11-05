# Language utilities for ansari-whatsapp
"""Utilities for language detection and text direction detection."""

import re
from typing import Literal


def get_language_from_text(text: str) -> str:
    """
    Detect the language of the text.

    This is a simplified implementation that can be improved with a proper
    language detection library like langdetect or langid.

    Args:
        text (str): The text to detect the language from.

    Returns:
        str: The detected language code, defaults to "en" (English).
    """
    # This is a placeholder function. In a real implementation, you would use
    # a proper language detection library.
    # For now, we'll just return English as the default language.
    return "en"


def get_language_direction_from_text(text: str) -> Literal["ltr", "rtl", "unknown"]:
    """
    Detect the text direction (left-to-right or right-to-left) of the given text.

    Args:
        text (str): The text to detect the direction from.

    Returns:
        Literal["ltr", "rtl", "unknown"]: The detected text direction.
    """
    # If the text has more rtl characters than ltr, it's considered rtl
    rtl_chars = re.findall(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+", text)
    rtl_count = sum(len(match) for match in rtl_chars)

    # If more than 30% of characters are RTL, consider it RTL
    if rtl_count / len(text) > 0.3:
        return "rtl"

    return "ltr"
