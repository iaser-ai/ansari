# Custom exceptions for ansari-whatsapp
"""Custom exception classes for the Ansari WhatsApp service."""


class UnexpectedMetaPayloadError(Exception):
    """Meta sent a message payload that is missing an expected key."""

    def __init__(self, message: str, reply_to: str | None = None):
        super().__init__(message)
        # Phone number or BSUID we can still use to reach the sender, if the payload had one
        self.reply_to = reply_to


class AuthTokenError(Exception):
    """Exchanging a BSUID for a JWT with apps/auth failed (an outage, a 500, or a network fault)."""

    pass


class AuthBadRequestError(AuthTokenError):
    """apps/auth answered 400: our request was malformed, which is a bug here. Never retried."""


class AuthKeyRejectedError(AuthTokenError):
    """apps/auth answered 401: our API key is bad (missing, revoked, expired, out of budget). Needs an operator."""


class AuthUserBannedError(AuthTokenError):
    """apps/auth answered 403: this user is banned."""


class AuthRateLimitedError(AuthTokenError):
    """apps/auth answered 429: this user's exchange budget is spent. The key is fine."""

    def __init__(self, message: str, retry_after: int):
        super().__init__(message)
        self.retry_after = retry_after  # Seconds until the user's budget frees up


class AnsariClientError(Exception):
    """Base exception for Ansari client errors."""

    pass


class ApiUnauthorizedError(AnsariClientError):
    """apps/api answered 401: it refused this user's token (a session can end after the token was signed)."""


class ThreadCreationError(AnsariClientError):
    """Thread creation failed."""

    pass


class ThreadDeletionError(AnsariClientError):
    """Deleting an expired thread failed."""

    pass


class ThreadInfoError(AnsariClientError):
    """Retrieving thread info failed."""

    pass


class MessageProcessingError(AnsariClientError):
    """Message processing failed."""

    pass
