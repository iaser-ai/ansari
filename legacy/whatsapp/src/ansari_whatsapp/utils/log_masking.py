# Masking for values about to be logged
"""Hide phone numbers, BSUIDs and message ids in text and structures that are about to be logged."""

import re

# A BSUID is a two-letter country code, a dot, then up to 128 letters or digits ("US.1349..."); a parent BSUID has
# ".ENT." after the country code. A message id is "wamid." plus base64 that carries the user's phone number. A phone
# number may contain spaces, hyphens, dots and parentheses. Meta's formats: business-scoped-user-ids and phone-numbers docs.
_MESSAGE_ID = re.compile(r"wamid\.[A-Za-z0-9+/=_-]+")
_BSUID = re.compile(r"\b[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}\b")
# Eight digits or more, so a 6 or 7 digit Meta error code stays readable
_PHONE = re.compile(r"[+(]?\d(?:[\s().-]{0,2}\d){7,}")


def mask_identifiers(text: str) -> str:
    """Replace anything shaped like a message id, BSUID or phone number with a placeholder."""
    text = _MESSAGE_ID.sub("<message-id>", text)
    text = _BSUID.sub("<bsuid>", text)
    return _PHONE.sub("<phone>", text)


def redact_values(obj, safe_keys: set[str], key: str | None = None):
    """Return obj with its structure intact but every string value masked as `<str len=N>`, except under `safe_keys`."""
    if isinstance(obj, dict):
        return {k: redact_values(v, safe_keys, k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_values(v, safe_keys, key) for v in obj]
    if isinstance(obj, str) and key not in safe_keys:
        return f"<str len={len(obj)}>"
    return obj
