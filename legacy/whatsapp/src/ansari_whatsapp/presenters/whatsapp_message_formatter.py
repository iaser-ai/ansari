# WhatsApp Message Formatter
"""Utilities for formatting messages for WhatsApp display (markdown conversion)."""

import re

from ansari_whatsapp.utils.language_utils import get_language_direction_from_text


def format_for_whatsapp(msg: str) -> str:
    """Convert conventional markdown syntax to WhatsApp's markdown syntax.

    Args:
        msg (str): The message to convert.

    Returns:
        str: The converted message with WhatsApp markdown.
    """
    msg_direction = get_language_direction_from_text(msg)

    # Process standard markdown syntax
    msg = convert_italic_syntax(msg)
    msg = convert_bold_syntax(msg)
    msg = convert_headers(msg)

    # Process lists based on text direction
    if msg_direction in ["ltr", "rtl"]:
        msg = format_nested_lists(msg)

    return msg


def convert_italic_syntax(text: str) -> str:
    """Convert markdown italic syntax (*text*) to WhatsApp italic syntax (_text_).

    Args:
        text (str): Text to convert

    Returns:
        str: Text with WhatsApp italic syntax
    """
    # Regex details:
    # (?<![\*_])  # Negative lookbehind: Ensures that the '*' is not preceded by '*' or '_'
    # \*          # Matches a literal '*'
    # ([^\*_]+?)  # Non-greedy match: Captures one or more characters that are not '*' or '_'
    # \*          # Matches a literal '*'
    # (?![\*_])   # Negative lookahead: Ensures that the '*' is not followed by '*' or '_'
    pattern = re.compile(r"(?<![\*_])\*([^\*_]+?)\*(?![\*_])")
    return pattern.sub(r"_\1_", text)


def convert_bold_syntax(text: str) -> str:
    """Convert markdown bold syntax (**text**) to WhatsApp bold syntax (*text*).

    Args:
        text (str): Text to convert

    Returns:
        str: Text with WhatsApp bold syntax
    """
    return text.replace("**", "*")


def convert_headers(text: str) -> str:
    """Convert markdown headers to WhatsApp's bold+italic format.

    Args:
        text (str): Text to convert

    Returns:
        str: Text with WhatsApp header format
    """
    # Process headers with content directly after them
    pattern = re.compile(r"(?! )#+ \**_*(.*?)\**_*\n(?!\n)")
    text = pattern.sub(r"*_\1_*\n\n", text)

    # Process headers with empty line after them
    pattern = re.compile(r"(?! )#+ \**_*(.*?)\**_*\n\n")
    return pattern.sub(r"*_\1_*\n\n", text)


def format_nested_lists(text: str) -> str:
    """Format only nested lists/bullet points with WhatsApp's special formatting.

    This handles:
    1. Nested bullet points within numbered lists
    2. Nested numbered lists within bullet points
    3. Purely nested bullet points
    4. Purely nested numbered lists

    Simple (non-nested) lists retain their original formatting.

    Args:
        text (str): Text to format

    Returns:
        str: Text with WhatsApp nested list formatting
    """
    lines = text.split("\n")
    processed_lines = []
    in_nested_section = False
    nested_section_indent = 0

    for i, line in enumerate(lines):
        # Check for indentation to detect nesting
        indent_match = re.match(r"^(\s+)", line) if line.strip() else None
        current_indent = len(indent_match.group(1)) if indent_match else 0

        # Check if this is a list item (numbered or bullet)
        is_numbered_item = re.match(r"^\s*\d+\.\s", line)
        is_bullet_item = re.match(r"^\s*[\*-]\s", line)

        # Determine if we're entering, in, or exiting a nested section
        if (is_numbered_item or is_bullet_item) and current_indent > 0:
            # This is a nested item
            if not in_nested_section:
                in_nested_section = True
                nested_section_indent = current_indent

            # Format nested items
            if is_numbered_item:
                # Convert nested numbered list format: "  1. Item" -> "  1 - Item"
                line = re.sub(r"(\s*)(\d+)(\.) ", r"\1\2 - ", line)
            elif is_bullet_item:
                # Convert nested bullet format: "  - Item" or "  * Item" -> "  -- Item"
                line = re.sub(r"(\s*)[\*-] ", r"\1-- ", line)

        elif in_nested_section and current_indent < nested_section_indent:
            # We're exiting the nested section
            in_nested_section = False

        # For non-nested items, leave them as they are
        processed_lines.append(line)

    return "\n".join(processed_lines)
