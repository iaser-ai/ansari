# Abstract base class for the apps/auth client
"""Defines the interface that all apps/auth client implementations must follow."""

from abc import ABC, abstractmethod


class AuthClientBase(ABC):
    """Exchanges a WhatsApp user's BSUID for a JWT that apps/api accepts."""

    @abstractmethod
    async def get_token(self, bsuid: str) -> str:
        """Get a JWT for the user identified by this BSUID.

        Args:
            bsuid (str): The business-scoped user ID from Meta's webhook (never a phone number).

        Returns:
            str: The JWT, sent as the bearer token on every apps/api call.

        Raises:
            AuthTokenError: If the exchange fails.
        """
        pass
