# Mock Meta WhatsApp API service implementation
"""Mock client implementation that simulates Meta WhatsApp API without making real HTTP requests."""

import asyncio

from loguru import logger

from ansari_whatsapp.services.meta_api_service_base import MetaApiServiceBase


class MetaApiServiceMock(MetaApiServiceBase):
    """Mock Meta WhatsApp API service for testing/development without real API calls."""

    def __init__(self):
        """Initialize mock Meta API service."""
        logger.info("Initialized MetaApiServiceMock - Meta API calls will be simulated")

    async def send_typing_indicator(self, recipient_phone: str, message_id: str) -> None:
        """Simulate sending typing indicator.

        Args:
            recipient_phone: WhatsApp phone number of recipient
            message_id: Message ID for the typing indicator
        """
        logger.info(f"[MOCK META API] Typing indicator simulated (msg_id: {message_id})")
        await asyncio.sleep(0.05)  # Simulate minimal network delay

    async def send_message(self, recipient_phone: str, message_parts: list[str]) -> None:
        """Simulate sending WhatsApp message.

        Args:
            recipient_phone: WhatsApp phone number of recipient
            message_parts: List of message parts (already split by length)
        """
        logger.info(f"[MOCK META API] Sending {len(message_parts)} message part(s)")

        for i, part in enumerate(message_parts, 1):
            # Don't log full message if it's just typing indicator
            if part == "...":
                logger.info(f"[MOCK META API] Part {i}/{len(message_parts)}: Typing indicator")
            else:
                logger.info(f"[MOCK META API] Part {i}/{len(message_parts)}: {len(part)} characters")

            await asyncio.sleep(0.1)  # Simulate send time per part

        logger.info(f"[MOCK META API] All {len(message_parts)} message part(s) simulated successfully")
