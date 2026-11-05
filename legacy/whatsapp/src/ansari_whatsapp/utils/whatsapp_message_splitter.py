# WhatsApp Message Splitter
"""Utilities for splitting long messages into WhatsApp-compliant chunks."""

import re


# WhatsApp character limit
WHATSAPP_MAX_MESSAGE_LENGTH = 4000


def split_message(msg_body: str) -> list[str]:
    """Split long messages into smaller chunks based on formatted headers or other patterns.

    This implements a multi-level splitting strategy for messages that exceed
    WhatsApp's character limit (4000):
    1. First tries to split by header pattern (*_HEADER_*)
    2. If that's not possible, tries to split by bold text (*BOLD*)
    3. Finally falls back to paragraph-based splitting

    Args:
        msg_body (str): The message body to split if necessary

    Returns:
        list[str]: A list of message chunks that can be sent separately
    """
    # If message is already under the limit, return it as is
    if len(msg_body) <= WHATSAPP_MAX_MESSAGE_LENGTH:
        return [msg_body]

    # Strategy 1: Try to split by formatted headers (*_HEADER_*)
    header_chunks = split_by_headers(msg_body, WHATSAPP_MAX_MESSAGE_LENGTH)
    if len(header_chunks) > 1:
        return header_chunks

    # Strategy 2: Try to split by bold formatting (*BOLD*)
    bold_chunks = split_by_bold_text(msg_body, WHATSAPP_MAX_MESSAGE_LENGTH)
    if len(bold_chunks) > 1:
        return bold_chunks

    # Strategy 3: Fall back to paragraph-based splitting
    return split_by_paragraphs(msg_body, WHATSAPP_MAX_MESSAGE_LENGTH)


def split_by_headers(text: str, max_length: int) -> list[str]:
    """Split text by formatted header pattern (*_HEADER_*).

    Args:
        text (str): Text to split
        max_length (int): Maximum allowed length of each chunk

    Returns:
        list[str]: List of text chunks split by headers
    """
    # Look for *_HEADER_* pattern
    header_pattern = re.compile(r"\*_[^*_]+_\*")
    headers = list(header_pattern.finditer(text))

    # If we don't have multiple headers, we can't split effectively
    if not headers or len(headers) <= 1:
        return [text]

    chunks = []

    # Process each header as a potential chunk boundary
    for i, match in enumerate(headers):
        # For the first header, handle any text that comes before it
        if i == 0 and match.start() > 0:
            prefix = text[: match.start()]

            # Always include the text before the first header in its own message(s)
            # If it's too long, recursively split it
            if len(prefix) <= max_length:
                chunks.append(prefix)
            else:
                # If prefix is too long, split it using paragraph-based splitting
                prefix_chunks = split_by_paragraphs(prefix, max_length)
                chunks.extend(prefix_chunks)

        # Determine the end position for the chunk containing this header
        end_pos = headers[i + 1].start() if i < len(headers) - 1 else len(text)
        chunk = text[match.start() : end_pos]

        # If chunk fits within limit, add it directly
        if len(chunk) <= max_length:
            chunks.append(chunk)
        else:
            # Otherwise, try more aggressive splitting for this chunk
            # First try bold formatting, then paragraphs
            sub_chunks = split_by_bold_text(chunk, max_length)
            chunks.extend(sub_chunks)

    return chunks


def split_by_bold_text(text: str, max_length: int) -> list[str]:
    """Split text by looking for bold formatting (*TEXT*) patterns.

    Args:
        text (str): Text to split
        max_length (int): Maximum allowed length of each chunk

    Returns:
        list[str]: List of text chunks split by bold formatting
    """
    if len(text) <= max_length:
        return [text]

    # Find *TEXT* patterns
    bold_pattern = re.compile(r"\*[^*]+\*")
    bold_matches = list(bold_pattern.finditer(text))

    # If we don't have enough bold patterns for effective splitting
    if not bold_matches or len(bold_matches) <= 1:
        return split_by_paragraphs(text, max_length)

    chunks = []

    # Process each bold pattern as a potential chunk boundary
    for i, match in enumerate(bold_matches):
        # For the first bold pattern, handle any text that comes before it
        if i == 0 and match.start() > 0:
            prefix = text[: match.start()]

            # Always include the text before the first bold pattern in its own message(s)
            # If it's too long, recursively split it
            if len(prefix) <= max_length:
                chunks.append(prefix)
            else:
                # If prefix is too long, split it using paragraph-based splitting
                prefix_chunks = split_by_paragraphs(prefix, max_length)
                chunks.extend(prefix_chunks)

        # Determine the end position for the chunk containing this bold pattern
        end_pos = bold_matches[i + 1].start() if i < len(bold_matches) - 1 else len(text)
        chunk = text[match.start() : end_pos]

        # If chunk fits within limit, add it directly
        if len(chunk) <= max_length:
            chunks.append(chunk)
        else:
            # Otherwise, fall back to paragraph splitting for this chunk
            sub_chunks = split_by_paragraphs(chunk, max_length)
            chunks.extend(sub_chunks)

    return chunks


def split_by_paragraphs(text: str, max_length: int) -> list[str]:
    """Split text by paragraphs or fall back to fixed-size chunks if needed.

    Args:
        text (str): Text to split
        max_length (int): Maximum allowed length of each chunk

    Returns:
        list[str]: List of text chunks split by paragraphs or fixed chunks
    """
    if len(text) <= max_length:
        return [text]

    chunks = []

    # Try splitting by paragraphs first (double newlines)
    paragraphs = re.split(r"\n\n+", text)

    if len(paragraphs) > 1:
        current = ""

        for para in paragraphs:
            # If adding this paragraph would exceed the limit
            if current and len(current) + len(para) + 2 > max_length:
                chunks.append(current)
                current = ""

            # If paragraph itself is too long, split it using fixed chunks
            if len(para) > max_length:
                # Add any accumulated text first
                if current:
                    chunks.append(current)
                    current = ""

                # Use fixed-size chunk splitting for long paragraphs
                para_chunks = split_by_fixed_chunks(para, max_length)
                chunks.extend(para_chunks)
            else:
                # Add paragraph to current chunk with proper separator
                if current:
                    current += "\n\n" + para
                else:
                    current = para

        # Don't forget the last chunk
        if current:
            chunks.append(current)

        return chunks
    else:
        # If text doesn't have paragraphs, use fixed-size chunk splitting
        return split_by_fixed_chunks(text, max_length)


def split_by_fixed_chunks(text: str, max_length: int) -> list[str]:
    """Split text into fixed-size chunks of maximum length.

    Args:
        text (str): Text to split
        max_length (int): Maximum allowed length of each chunk

    Returns:
        list[str]: List of text chunks of maximum length
    """
    # If text is already under the limit, return it as is
    if len(text) <= max_length:
        return [text]

    chunks = []
    start = 0
    while len(text) - start > max_length:
        end = start + max_length
        # Cut after the last whitespace in the second half of the window so a word, URL or *bold* pair is not split
        cut = max(text.rfind(" ", start, end), text.rfind("\n", start, end)) + 1
        if cut > start + max_length // 2:
            end = cut
        chunks.append(text[start:end])
        start = end
    chunks.append(text[start:])

    return chunks
