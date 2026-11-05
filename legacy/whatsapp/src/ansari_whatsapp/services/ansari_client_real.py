# Real API Client for ansari-whatsapp
"""Real client implementation for interacting with the Ansari backend API via HTTP."""

import json

import httpx

from loguru import logger

from ansari_whatsapp.utils.config import get_settings
from ansari_whatsapp.utils.exceptions import (
    ThreadCreationError,
    ThreadDeletionError,
    ThreadInfoError,
    MessageProcessingError,
)
from ansari_whatsapp.services.ansari_client_base import AnsariClientBase

# Per-client attribution id sent to apps/api (lowercase, per packages/types attribution)
CLIENT_ID = "askansari-whatsapp"


class AnsariClientReal(AnsariClientBase):
    """Real client for the Ansari backend API that makes actual HTTP requests.

    Uses a persistent httpx.AsyncClient with connection pooling for better performance.
    References:
    - https://www.python-httpx.org/advanced/clients/#client-instances
    - https://www.python-httpx.org/advanced/clients/#why-use-a-client
    """

    def __init__(self):
        """Initialize the Ansari API client with persistent HTTP client and authentication.

        The persistent client provides several benefits:
        - Connection pooling and reuse for improved performance
        - Automatic header injection (authentication, content-type)
        - Single configuration point for all HTTP requests

        References:
        - https://www.python-httpx.org/advanced/#client-instances
        - https://fastapi.tiangolo.com/tutorial/security/
        """
        self.settings = get_settings()
        self.base_url = self.settings.BACKEND_SERVER_URL

        # Persistent HTTP client; the user's JWT is added per request, since each user has their own
        self.client = httpx.AsyncClient(
            headers={
                "X-Ansari-Client": CLIENT_ID,
                "Content-Type": "application/json",
            },
            timeout=60.0,  # Default timeout for all requests
        )

    @staticmethod
    def _auth(token: str) -> dict:
        return {"Authorization": f"Bearer {token}"}

    async def close(self):
        """Close the HTTP client connection and release resources.

        This should be called when the client is no longer needed to properly clean up
        connection pools and background tasks.

        References:
        - https://www.python-httpx.org/advanced/#client-instances
        - https://www.python-httpx.org/async/#opening-and-closing-clients
        """
        await self.client.aclose()

    async def create_thread(self, token: str, title: str) -> dict:
        """
        Create a new thread for the user that this JWT belongs to.

        Args:
            token (str): The user's JWT from apps/auth.
            title (str): The title of the thread.

        Returns:
            dict: The creation result with thread_id.

        Raises:
            ThreadCreationError: If thread creation fails.
        """
        try:
            response = await self.client.post(
                f"{self.base_url}/api/v2/threads",
                json={"name": title, "source": "whatsapp"},
                headers=self._auth(token),
            )
            response.raise_for_status()
            return {"thread_id": response.json()["thread_id"]}
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error creating thread: {e.response.status_code}")
            raise ThreadCreationError(f"Failed to create thread: HTTP {e.response.status_code}") from e
        except httpx.RequestError as e:
            logger.error(f"Network error creating thread: {type(e).__name__}")
            raise ThreadCreationError("Network error during thread creation") from e
        except (KeyError, ValueError) as e:
            logger.error("apps/api returned an unexpected thread-creation response")
            raise ThreadCreationError("Unexpected thread-creation response") from e

    async def delete_thread(self, token: str, thread_id: str) -> None:
        """
        Delete a thread and, with it, all of its messages (apps/api cascades the delete).

        A 404 means the thread is already gone, which is the outcome we wanted, so it is not an error.

        Args:
            token (str): The user's JWT from apps/auth.
            thread_id (str): The ID of the thread to delete.

        Raises:
            ThreadDeletionError: If deletion fails.
        """
        try:
            response = await self.client.delete(f"{self.base_url}/api/v2/threads/{thread_id}", headers=self._auth(token))
            if response.status_code == 404:
                return
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error deleting thread: {e.response.status_code}")
            raise ThreadDeletionError(f"Failed to delete thread: HTTP {e.response.status_code}") from e
        except httpx.RequestError as e:
            logger.error(f"Network error deleting thread: {type(e).__name__}")
            raise ThreadDeletionError("Network error during thread deletion") from e

    async def get_last_thread_info(self, token: str) -> dict:
        """
        Get information about the user's most recently active thread.

        apps/api lists a user's threads newest-first by `updated_at`, which it bumps on every message. Only threads
        this service created (`source` is `whatsapp`) count, so an expired one is never mistaken for, or deleted
        in place of, a thread from another client.

        Args:
            token (str): The user's JWT from apps/auth.

        Returns:
            dict: The thread info with thread_id and last_message_time (both None if no thread yet).

        Raises:
            ThreadInfoError: If retrieving thread info fails.
        """
        try:
            response = await self.client.get(f"{self.base_url}/api/v2/threads", headers=self._auth(token))
            response.raise_for_status()
            threads = [t for t in response.json() if t.get("source") == "whatsapp"]
            if not threads:
                return {"thread_id": None, "last_message_time": None}
            return {"thread_id": threads[0]["thread_id"], "last_message_time": threads[0]["updated_at"]}
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error getting last thread info: {e.response.status_code}")
            raise ThreadInfoError(f"Failed to get last thread info: HTTP {e.response.status_code}") from e
        except httpx.RequestError as e:
            logger.error(f"Network error getting last thread info: {type(e).__name__}")
            raise ThreadInfoError("Network error during thread info retrieval") from e
        except (KeyError, ValueError, TypeError) as e:
            logger.error("apps/api returned an unexpected thread-list response")
            raise ThreadInfoError("Unexpected thread-list response") from e

    async def process_message(self, token: str, thread_id: str, message: str) -> str:
        """
        Send a message to apps/api and collect the full streamed answer.

        Uses `POST /api/v2/threads/{id}/chat`, a Server-Sent Events stream, the same route the web app uses:
        lines starting with `:` are keep-alives, and each `data:` line is a JSON event: `text` (a piece of the
        answer), `tool_call` / `tool_result` (ignored), `error`, and a final `done`. A stream with an `error`
        event, or one that ends without `done`, is a failure, so a half answer is never passed on as complete.

        Args:
            token (str): The user's JWT from apps/auth.
            thread_id (str): The ID of the thread.
            message (str): The message to process.

        Returns:
            str: The complete response message.

        Raises:
            MessageProcessingError: If message processing fails.
        """
        try:
            url = f"{self.base_url}/api/v2/threads/{thread_id}/chat"
            data = {"message": message}

            # Use stream=True to receive the response as a stream
            async with self.client.stream("POST", url, json=data, headers=self._auth(token)) as response:
                if response.status_code != 200:
                    logger.error(f"Error from backend API: HTTP {response.status_code}")
                    raise MessageProcessingError(f"Backend returned HTTP {response.status_code}")

                # Accumulate the answer from the `text` events
                full_response = ""
                done = False
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue  # keep-alive comments and blank separator lines
                    try:
                        event = json.loads(line[len("data:") :])
                    except ValueError as e:
                        logger.error("apps/api sent a chat event that is not JSON")
                        raise MessageProcessingError("Malformed chat event") from e
                    event_type = event.get("type") if isinstance(event, dict) else None
                    if event_type == "text":
                        full_response += event.get("content") or ""
                    elif event_type == "error":
                        # The message is apps/api's own text, never user content, so it is safe to log
                        logger.error(f"apps/api reported a chat error: {event.get('message')}")
                        raise MessageProcessingError("apps/api reported an error while answering")
                    elif event_type == "done":
                        done = True

                if not done:
                    logger.error("The chat stream from apps/api ended before it was complete")
                    raise MessageProcessingError("Chat stream ended before completion")

                if not full_response:
                    logger.warning("Received empty response from backend")
                    return ""

                return full_response
        except httpx.TimeoutException as e:
            logger.error(f"Timeout processing message: {e}")
            raise MessageProcessingError("Request timed out while processing message") from e
        except httpx.RequestError as e:
            logger.error(f"Network error processing message: {type(e).__name__}")
            raise MessageProcessingError("Network error during message processing") from e
        except MessageProcessingError:
            # Re-raise our custom exception without wrapping
            raise
        except Exception as e:
            logger.error(f"Unexpected error processing message: {type(e).__name__}")
            raise MessageProcessingError(f"Unexpected error: {type(e).__name__}") from e
