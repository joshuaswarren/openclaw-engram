"""Engram MemoryProvider protocol implementation for Hermes Agent."""

from __future__ import annotations

import json
import os
from typing import Any

from engram_hermes.client import EngramClient


class EngramMemoryProvider:
    """MemoryProvider that delegates to the EMO daemon via HTTP.

    Lifecycle:
      - initialize()        → connect to EMO, verify health
      - pre_llm_call()      → recall relevant memories, inject into system prompt
      - sync_turn()         → observe the latest conversation turn
      - extract_memories()  → structured extraction at session end
      - shutdown()          → close HTTP client
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        config = config or {}
        self._host = config.get("host", os.environ.get("ENGRAM_HOST", "127.0.0.1"))
        self._port = int(config.get("port", os.environ.get("ENGRAM_PORT", "4318")))
        self._token = config.get("token", "")
        self._session_key = config.get("session_key", "")
        self._client: EngramClient | None = None

        # Load token from file if not in config
        if not self._token:
            token_path = os.path.expanduser("~/.engram/tokens.json")
            if os.path.exists(token_path):
                with open(token_path) as f:
                    tokens = json.load(f)
                    self._token = tokens.get("hermes", tokens.get("openclaw", ""))

    async def initialize(self, config: dict[str, Any] | None = None) -> None:
        """Connect to EMO daemon and verify health."""
        self._client = EngramClient(
            host=self._host,
            port=self._port,
            token=self._token,
            client_id="hermes",
        )
        try:
            await self._client.health()
        except Exception:
            pass  # Non-fatal — daemon might start later

    async def pre_llm_call(self, messages: list[dict[str, str]]) -> str:
        """Recall relevant memories and return context to inject into system prompt."""
        if not self._client:
            return ""

        # Use the last user message as the recall query
        query = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                query = msg.get("content", "")
                break

        if not query or len(query.split()) < 3:
            return ""

        try:
            result = await self._client.recall(
                query=query,
                session_key=self._session_key,
                top_k=8,
                mode="minimal",
            )
            context = result.get("context", "")
            count = result.get("count", 0)
            if context and count > 0:
                return f"<engram-memory count=\"{count}\">\n{context}\n</engram-memory>"
        except Exception:
            pass

        return ""

    async def sync_turn(self, transcript: list[dict[str, str]]) -> None:
        """Observe the latest conversation turn."""
        if not self._client or not transcript:
            return

        # Send the last 2 messages (user + assistant)
        recent = transcript[-2:] if len(transcript) >= 2 else transcript
        try:
            await self._client.observe(
                session_key=self._session_key,
                messages=recent,
            )
        except Exception:
            pass

    async def extract_memories(self, session: dict[str, Any]) -> None:
        """Structured extraction at session end — send full transcript for deep analysis."""
        if not self._client:
            return

        messages = session.get("messages", [])
        if not messages:
            return

        try:
            await self._client.observe(
                session_key=self._session_key,
                messages=messages,
            )
        except Exception:
            pass

    async def shutdown(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.close()
            self._client = None

    # -- Explicit tool schemas for Hermes tool registration --

    recall_schema = {
        "name": "engram_recall",
        "description": "Recall memories from Engram matching a natural language query",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language recall query"},
            },
            "required": ["query"],
        },
    }

    store_schema = {
        "name": "engram_store",
        "description": "Store a memory in Engram for future recall",
        "parameters": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Memory content to store"},
            },
            "required": ["content"],
        },
    }

    search_schema = {
        "name": "engram_search",
        "description": "Full-text search across all Engram memories",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
            },
            "required": ["query"],
        },
    }

    async def recall(self, query: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for engram_recall."""
        if not self._client:
            return {"error": "Not connected to Engram"}
        return await self._client.recall(query=query, session_key=self._session_key)

    async def store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for engram_store."""
        if not self._client:
            return {"error": "Not connected to Engram"}
        return await self._client.store(content=content)

    async def search(self, query: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for engram_search."""
        if not self._client:
            return {"error": "Not connected to Engram"}
        return await self._client.search(query=query)
