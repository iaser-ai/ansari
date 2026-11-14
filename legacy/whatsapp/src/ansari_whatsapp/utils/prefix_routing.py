"""Which environment answers a message, decided by an optional prefix (issue #363).

The production WhatsApp number is subscribed to the production, staging and development Meta apps, so every message reaches all
three environments. A text starting with "!s " is for staging, one starting with "!d " is for a developer's machine, and
anything else is for production.
"""

# Names as in apps/api and apps/auth
OWN_PREFIX = {"development": "!d ", "staging": "!s "}
ALL_PREFIXES = ("!d ", "!s ")


def route_by_prefix(environment: str, body: object) -> tuple[bool, object]:
    """Return (answers, body): whether this environment answers, and the body with its own prefix removed if it does.

    `body` is Meta's message body: a dict with the text under "body", or a list for a type we cannot read.
    """
    text = body.get("body") if isinstance(body, dict) else None
    if not isinstance(text, str):
        # Only text can carry a prefix, so a message of any other type belongs to production
        return environment == "production", body

    own = OWN_PREFIX.get(environment)
    if own is None:
        return not text.startswith(ALL_PREFIXES), body
    if text.startswith(own):
        return True, {**body, "body": text[len(own) :]}
    return False, body
