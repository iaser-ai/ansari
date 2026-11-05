# Abstract base class for Ansari clients
"""Defines the interface that all Ansari client implementations must follow."""

from abc import ABC, abstractmethod


class AnsariClientBase(ABC):
    """Abstract base class defining the interface for Ansari clients.

    This interface ensures that both real and mock implementations
    provide the same methods with consistent signatures.
    """

    @abstractmethod
    async def create_thread(self, token: str, title: str) -> dict:
        """Create a new thread for the user that this JWT belongs to.

        Args:
            token (str): The user's JWT from apps/auth.
            title (str): The title of the thread.

        Returns:
            dict: The creation result with format {"thread_id": "..."}

        Raises:
            ThreadCreationError: If thread creation fails.
        """
        pass

    @abstractmethod
    async def delete_thread(self, token: str, thread_id: str) -> None:
        """Delete a thread and, with it, all of its messages.

        Deleting a thread that is already gone is not an error.

        Args:
            token (str): The user's JWT from apps/auth.
            thread_id (str): The ID of the thread to delete.

        Raises:
            ThreadDeletionError: If deletion fails.
        """
        pass

    @abstractmethod
    async def get_last_thread_info(self, token: str) -> dict:
        """Get information about the user's most recently active thread.

        Args:
            token (str): The user's JWT from apps/auth.

        Returns:
            dict: The thread info with format {"thread_id": "...", "last_message_time": "..."};
                both values are None if the user has no thread yet.

        Raises:
            ThreadInfoError: If retrieving thread info fails.
        """
        pass

    @abstractmethod
    async def process_message(self, token: str, thread_id: str, message: str) -> str:
        """Send a message to apps/api and collect the full streamed answer.

        Args:
            token (str): The user's JWT from apps/auth.
            thread_id (str): The ID of the thread.
            message (str): The message to process.

        Returns:
            str: The complete response message.

        Raises:
            MessageProcessingError: If message processing fails.
        """
        pass
