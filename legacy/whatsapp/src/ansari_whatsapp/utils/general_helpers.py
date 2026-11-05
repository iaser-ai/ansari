# General utility helpers for ansari-whatsapp
"""General utility functions that can be used across the codebase."""

import json
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from urllib.parse import urlparse


# Custom CORS middleware to log errors that occur in the middleware layer (if any)
class CORSMiddlewareWithLogging(CORSMiddleware):
    async def __call__(self, scope, receive, send):
        """Override the __call__ method to add logging"""
        # Skip CORS processing for non-HTTP requests (e.g., WebSockets)
        if scope["type"] != "http":  # pragma: no cover
            return await super().__call__(scope, receive, send)

        logger.debug("Starting CORS middleware processing")

        # Create a Request object for logging
        request = Request(scope, receive)

        async def modified_send(message):
            """Intercept response to log CORS errors"""
            if message["type"] == "http.response.start":
                status = message["status"]
                # Common request details
                request_details = (
                    f"Status: {status}\n"
                    f"Path: {request.url.path}\n"
                    f"Method: {request.method}\n"
                    f"Origin: {request.headers.get('origin')}\n"
                    f"Host: {request.headers.get('host')}"
                )

                # Log CORS-related errors (if any)
                if request.headers.get("origin") is not None and request.headers.get("origin") not in self.allow_origins:
                    logger.error(
                        f"CORS Origin Error\n"
                        f"Incoming Origin: {request.headers.get('origin')}\n"
                        f"Incoming Host: {request.headers.get('host')}\n"
                        f"But the allowed Origins:\n{json.dumps(self.allow_origins, indent=2)}"
                    )
                # Else log issues that occur in the middleware layer (if any)
                elif any(
                    [
                        status == 400 and request.method == "OPTIONS",
                        status == 401 and "Authorization" not in request.headers,
                        status == 403 and request.headers.get("origin") not in self.allow_origins,
                        status == 429,
                    ]
                ):
                    logger.error(f"Middleware Error\n{request_details}")
            await send(message)

        try:
            await super().__call__(scope, receive, modified_send)
        except Exception as e:
            logger.error(
                (
                    f"Unhandled Middleware Error\nType: {type(e).__name__}\n"
                    f"Message: {str(e)}\n"
                    f"Path: {request.url.path}\n"
                    f"Method: {request.method}\n"
                    f"Origin: {request.headers.get('origin')}\n"
                    f"Host: {request.headers.get('host')}"
                ),
                exc_info=True,
            )
            raise


def get_base_url(url):
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"
