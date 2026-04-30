"""Remnic MemoryProvider protocol implementation for Hermes Agent."""

from __future__ import annotations

import uuid
from typing import Any

from remnic_hermes.client import RemnicClient
from remnic_hermes.config import RemnicHermesConfig


class RemnicMemoryProvider:
    """MemoryProvider that delegates to the Remnic daemon via HTTP.

    Lifecycle:
      - initialize()        → connect to Remnic, verify health
      - pre_llm_call()      → recall relevant memories, inject into system prompt
      - sync_turn()         → observe the latest conversation turn
      - extract_memories()  → structured extraction at session end
      - shutdown()          → close HTTP client
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = RemnicHermesConfig.from_hermes_config(config or {})
        self._host = cfg.host
        self._port = cfg.port
        self._token = cfg.token
        self._timeout = cfg.timeout
        self._session_key = cfg.session_key or f"hermes-{uuid.uuid4().hex[:12]}"
        self._client: RemnicClient | None = None

    async def initialize(self, config: dict[str, Any] | None = None) -> None:
        """Connect to Remnic daemon and verify health."""
        self._client = RemnicClient(
            host=self._host,
            port=self._port,
            token=self._token,
            client_id="hermes",
            timeout=self._timeout,
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
            )
            context = result.get("context", "")
            count = result.get("count", 0)
            if context and count > 0:
                return f"<remnic-memory count=\"{count}\">\n{context}\n</remnic-memory>"
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
        "name": "remnic_recall",
        "description": "Recall memories from Remnic matching a natural language query",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language recall query"},
            },
            "required": ["query"],
        },
    }

    store_schema = {
        "name": "remnic_store",
        "description": "Store a memory in Remnic for future recall",
        "parameters": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Memory content to store"},
            },
            "required": ["content"],
        },
    }

    search_schema = {
        "name": "remnic_search",
        "description": "Full-text search across all Remnic memories",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
            },
            "required": ["query"],
        },
    }
    lcm_search_schema = {
        "name": "remnic_lcm_search",
        "description": "Search the daemon-side Lossless Context Management conversation archive",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "sessionKey": {"type": "string", "description": "Optional session filter"},
                "namespace": {"type": "string"},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "Max results to return",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    }

    # Legacy schemas — same handlers, engram_* tool names. Kept so existing
    # Hermes configs that reference engram_recall / engram_store / engram_search
    # continue to resolve. Descriptions keep the Engram brand so the tool name
    # and description agree when LLMs surface the legacy names. Remove once
    # the compat window closes.
    legacy_recall_schema = {
        **recall_schema,
        "name": "engram_recall",
        "description": "Recall memories from Engram matching a natural language query",
    }
    legacy_store_schema = {
        **store_schema,
        "name": "engram_store",
        "description": "Store a memory in Engram for future recall",
    }
    legacy_search_schema = {
        **search_schema,
        "name": "engram_search",
        "description": "Full-text search across all Engram memories",
    }
    legacy_lcm_search_schema = {
        **lcm_search_schema,
        "name": "engram_lcm_search",
        "description": "Search the daemon-side Engram Lossless Context Management conversation archive",
    }

    async def recall(self, query: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for remnic_recall / engram_recall."""
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.recall(query=query, session_key=self._session_key)

    async def store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for remnic_store / engram_store."""
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.store(content=content)

    async def search(self, query: str, **kwargs: Any) -> dict[str, Any]:
        """Tool handler for remnic_search / engram_search."""
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.search(query=query)

    async def lcm_search(
        self,
        query: str,
        sessionKey: str = "",
        namespace: str | None = None,
        limit: int | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Tool handler for remnic_lcm_search / engram_lcm_search."""
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.lcm_search(
            query=query,
            session_key=sessionKey,
            namespace=namespace,
            limit=limit,
        )


# Legacy class alias — import path compat for pre-rename consumers.
EngramMemoryProvider = RemnicMemoryProvider
