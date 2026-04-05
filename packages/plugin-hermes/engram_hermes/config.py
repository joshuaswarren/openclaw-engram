"""Configuration loading for the Engram Hermes plugin."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass


@dataclass
class EngramHermesConfig:
    """Configuration for the Engram Hermes MemoryProvider."""

    host: str = "127.0.0.1"
    port: int = 4318
    token: str = ""
    session_key: str = ""
    timeout: float = 30.0

    @classmethod
    def from_hermes_config(cls, config: dict[str, object]) -> EngramHermesConfig:
        """Load from the engram config section (already extracted by the register() caller).

        Accepts either the top-level Hermes config (with 'engram' key) or the
        pre-extracted engram section directly.
        """
        # Support both top-level config (with engram key) and pre-extracted section
        engram_candidate = config.get("engram")
        if isinstance(engram_candidate, dict):
            engram = engram_candidate
        else:
            engram = config  # already the engram section

        token = str(engram.get("token", ""))
        if not token:
            token = _load_token_from_file()

        return cls(
            host=str(engram.get("host", os.environ.get("ENGRAM_HOST", "127.0.0.1"))),
            port=int(engram.get("port", os.environ.get("ENGRAM_PORT", "4318"))),
            token=token,
            session_key=str(engram.get("session_key", "")),
            timeout=float(engram.get("timeout", 30.0)),
        )


def _load_token_from_file() -> str:
    """Load the hermes token from ~/.engram/tokens.json."""
    token_path = os.path.expanduser("~/.engram/tokens.json")
    if not os.path.exists(token_path):
        return ""
    try:
        with open(token_path) as f:
            tokens = json.load(f)
            return str(tokens.get("hermes", tokens.get("openclaw", "")))
    except (json.JSONDecodeError, OSError):
        return ""
