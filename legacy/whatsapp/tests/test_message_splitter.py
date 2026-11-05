"""Tests for splitting an answer that is longer than WhatsApp's 4000-character limit."""

import re

from ansari_whatsapp.utils.whatsapp_message_splitter import WHATSAPP_MAX_MESSAGE_LENGTH, split_message

LIMIT = WHATSAPP_MAX_MESSAGE_LENGTH


def _paragraphs(count: int, size: int = 500) -> str:
    return "\n\n".join(f"{i:03d} " + "w" * (size - 4) for i in range(count))


def test_a_short_message_is_not_split():
    assert split_message("hello") == ["hello"]


def test_a_message_of_exactly_the_limit_is_not_split():
    assert split_message("a" * LIMIT) == ["a" * LIMIT]


def test_a_long_message_is_split_into_chunks_within_the_limit_and_in_order():
    text = _paragraphs(30)

    chunks = split_message(text)

    assert len(chunks) > 1
    assert all(len(chunk) <= LIMIT for chunk in chunks)
    assert [m for chunk in chunks for m in re.findall(r"^\d{3}", chunk, re.M)] == [f"{i:03d}" for i in range(30)]


def test_no_text_is_lost_when_splitting_by_paragraphs():
    text = _paragraphs(30)

    chunks = split_message(text)

    assert "\n\n".join(chunks) == text


def test_one_giant_unbroken_message_is_cut_into_limit_sized_pieces_in_order():
    text = "".join(chr(97 + i % 26) for i in range(LIMIT * 2 + 123))

    chunks = split_message(text)

    assert all(len(chunk) <= LIMIT for chunk in chunks)
    assert "".join(chunks) == text


def test_headers_start_new_chunks():
    section = "*_Title_*\n" + "x" * 2500
    text = "\n\n".join([section, section, section])

    chunks = split_message(text)

    assert len(chunks) == 3
    assert all(chunk.startswith("*_Title_*") for chunk in chunks)


def test_a_long_bold_phrase_is_not_cut_in_half():
    """Splitting at a paragraph break must never separate the two stars of a bold phrase."""
    bold = "*" + "b" * 100 + "*"
    text = "\n\n".join([bold + " " + "a" * 3500, bold + " " + "c" * 3500])

    chunks = split_message(text)

    assert all(chunk.count("*") % 2 == 0 for chunk in chunks)


def test_a_url_is_not_cut_in_half():
    url = "https://example.org/" + "u" * 200
    text = "a" * (LIMIT - 50) + " " + url + " " + "z" * 500

    chunks = split_message(text)

    assert any(url in chunk for chunk in chunks)
