# Mock API Client for ansari-whatsapp
"""Mock client implementation that simulates apps/api without making real HTTP requests."""

import random
import asyncio
from datetime import datetime, timezone
from functools import wraps
from typing import Callable

from loguru import logger

from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.exceptions import (
    ThreadCreationError,
    ThreadDeletionError,
    ThreadInfoError,
    MessageProcessingError,
)
from ansari_whatsapp.services.ansari_client_base import AnsariClientBase


def simulate_backend_behavior(
    min_latency_s: int = 1, max_latency_s: int = 2, error_rate: float = 0.0, error_class: type[Exception] | None = None
) -> Callable:
    """Decorator that simulates backend behavior with configurable latency and error rates.

    Args:
        min_latency_s: Minimum simulated network delay in seconds (default: 1)
        max_latency_s: Maximum simulated network delay in seconds (default: 2)
        error_rate: Probability of simulated errors, 0.0-1.0 (default: 0.0, no errors)
        error_class: Specific exception class to raise, or None to auto-detect (default: None)

    Returns:
        Decorator function that wraps the target function with simulated backend behavior
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            await asyncio.sleep(random.uniform(min_latency_s, max_latency_s))

            if error_rate > 0 and random.random() < error_rate:
                logger.warning(f"Mock client simulating error for {func.__name__}")

                exception_class = error_class
                if exception_class is None:
                    if "create" in func.__name__:
                        exception_class = ThreadCreationError
                    elif "delete" in func.__name__:
                        exception_class = ThreadDeletionError
                    elif "thread" in func.__name__:
                        exception_class = ThreadInfoError
                    elif "message" in func.__name__:
                        exception_class = MessageProcessingError
                    else:
                        exception_class = Exception

                raise exception_class(f"Simulated error in {func.__name__}")

            return await func(*args, **kwargs)

        return wrapper

    return decorator


class AnsariClientMock(AnsariClientBase):
    """Mock implementation of the Ansari client for testing without apps/api.

    Threads are kept in memory per token, mirroring apps/api, where the token alone identifies the user.
    The mock auth client gives each BSUID its own stable token.
    """

    def __init__(self):
        """Initialize the mock Ansari API client with in-memory state."""
        self.settings = get_settings()
        self._threads = {}  # thread_id -> thread_data
        self._thread_counter = 0

        logger.info("Initialized AnsariClientMock - using mock backend")

    def _user(self, token: str, error: type[Exception]) -> str:
        if not token:
            raise error("Invalid token")
        return token

    @simulate_backend_behavior()
    async def create_thread(self, token: str, title: str) -> dict:
        """Mock thread creation.

        Returns:
            dict: Creation result matching backend format {"thread_id": "..."}
        """
        user = self._user(token, ThreadCreationError)

        self._thread_counter += 1
        thread_id = f"mock_thread_{self._thread_counter}"

        self._threads[thread_id] = {
            "thread_id": thread_id,
            "user": user,
            "title": title,
            "messages": [],
            "last_message_time": datetime.now(timezone.utc).isoformat(),
        }

        logger.info(f"Mock: Created thread {thread_id}")
        return {"thread_id": thread_id}

    @simulate_backend_behavior()
    async def delete_thread(self, token: str, thread_id: str) -> None:
        """Mock thread deletion (its messages go with it). A thread that is already gone is not an error."""
        user = self._user(token, ThreadDeletionError)

        thread = self._threads.get(thread_id)
        if thread is None:
            return
        if thread["user"] != user:
            raise ThreadDeletionError("Thread access denied")

        del self._threads[thread_id]
        logger.info(f"Mock: Deleted thread {thread_id}")

    @simulate_backend_behavior()
    async def get_last_thread_info(self, token: str) -> dict:
        """Mock last thread info retrieval.

        Returns:
            dict: Thread info matching backend format {"thread_id": "...", "last_message_time": "..."}
        """
        user = self._user(token, ThreadInfoError)
        user_threads = [t for t in self._threads.values() if t["user"] == user]

        if not user_threads:
            logger.debug("Mock: No threads found for user")
            return {"thread_id": None, "last_message_time": None}

        latest_thread = max(user_threads, key=lambda t: t["last_message_time"])
        return {
            "thread_id": latest_thread["thread_id"],
            "last_message_time": latest_thread["last_message_time"],
        }

    @simulate_backend_behavior()
    async def process_message(self, token: str, thread_id: str, message: str) -> str:
        """Mock message processing with simulated AI response.

        Returns:
            str: Mock AI response (uses saved sample response if message contains "long")
        """
        user = self._user(token, MessageProcessingError)

        thread = self._threads.get(thread_id)
        if thread is None:
            logger.error(f"Mock: Thread {thread_id} not found for message processing")
            raise MessageProcessingError("Thread not found")

        if thread["user"] != user:
            logger.error(f"Mock: Thread {thread_id} does not belong to this user")
            raise MessageProcessingError("Thread access denied")

        thread["messages"].append({"role": "user", "content": message})

        response = f"This is a *mock AI assistant* running in test mode. Write 'long' to see a bigger mock response.\n\nYour message: {message[:100]}"
        # If message contains "long", try to load the saved sample response
        if "long" in message.lower():
            try:
                from pathlib import Path

                sample_file = (
                    Path(__file__).parent.parent.parent.parent
                    / "docs"
                    / "sample_backend_responses"
                    / "sample_ansari_llm_response.txt"
                )

                if sample_file.exists():
                    with open(sample_file, "r", encoding="utf-8") as f:
                        response = f.read()
                    logger.info(f"Mock: Using saved sample response from {sample_file}")
                else:
                    logger.warning(f"Mock: Sample response file not found at {sample_file}, using default response")
            except Exception as e:
                logger.warning(f"Mock: Failed to load sample response: {e}, using default response")

        thread["messages"].append({"role": "assistant", "content": response})
        thread["last_message_time"] = datetime.now(timezone.utc).isoformat()

        logger.info(f"Mock: Processed message for thread {thread_id}, response length: {len(response)}")
        return response
