# Custom exceptions for ansari-whatsapp
"""Custom exception classes for the Ansari WhatsApp service."""


class UnexpectedMetaPayloadError(Exception):
    """Meta sent a message payload that is missing an expected key."""

    def __init__(self, message: str, reply_to: str | None = None):
        super().__init__(message)
        # Phone number or BSUID we can still use to reach the sender, if the payload had one
        self.reply_to = reply_to


class AuthTokenError(Exception):
    """Exchanging a BSUID for a JWT with apps/auth failed."""

    pass


class AnsariClientError(Exception):
    """Base exception for Ansari client errors."""

    pass


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
