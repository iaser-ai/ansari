"""
Test utilities for WhatsApp microservice tests.

This module provides common test functionality following
the backend test patterns (pytest + TestClient + fixtures).
"""

import json
from typing import Any, Dict
from datetime import datetime


def log_test_result(test_name: str, success: bool, message: str, response_data: Any = None) -> Dict[str, Any]:
    """
    Create a test result log entry.

    Args:
        test_name: Name of the test
        success: Whether the test passed
        message: Test result message
        response_data: Response data to include

    Returns:
        Dictionary containing the log entry
    """
    result = {"test_name": test_name, "success": success, "message": message, "timestamp": datetime.now().isoformat()}

    if response_data is not None:
        result["response_data"] = response_data

    return result


def format_payload_for_logging(payload: Dict[str, Any]) -> str:
    """
    Format payload for logging.

    Args:
        payload: The payload dictionary

    Returns:
        JSON string
    """
    return json.dumps(payload, indent=2)


def format_params_for_logging(params: Dict[str, Any]) -> str:
    """
    Format URL parameters for logging.

    Args:
        params: The parameters dictionary

    Returns:
        JSON string
    """
    return json.dumps(params, indent=2)
