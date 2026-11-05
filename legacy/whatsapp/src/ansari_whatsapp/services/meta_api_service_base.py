# Abstract base class for Meta WhatsApp API services
"""Defines the interface for Meta WhatsApp API interactions."""

from abc import ABC, abstractmethod


class MetaApiServiceBase(ABC):
    """Abstract base class defining the interface for Meta WhatsApp API services.

    This interface ensures that both real and mock implementations
    provide the same methods with consistent signatures.
    """

    @abstractmethod
    async def send_typing_indicator(self, recipient_phone: str, message_id: str) -> None:
        """Send typing indicator to WhatsApp recipient.

        Args:
            recipient_phone (str): WhatsApp phone number of recipient
            message_id (str): Message ID for the typing indicator

        Raises:
            Exception: If sending typing indicator fails
        """
        pass

    @abstractmethod
    async def send_message(self, recipient_phone: str, message_parts: list[str]) -> None:
        """Send WhatsApp message(s) to recipient.

        Args:
            recipient_phone (str): WhatsApp phone number of recipient
            message_parts (list[str]): List of message parts (already split by length)

        Raises:
            Exception: If sending message fails
        """
        pass
