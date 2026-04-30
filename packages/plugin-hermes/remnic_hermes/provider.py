"""Remnic MemoryProvider protocol implementation for Hermes Agent."""

from __future__ import annotations

import uuid
from typing import Any

from remnic_hermes.client import RemnicClient
from remnic_hermes.config import RemnicHermesConfig


_NAMESPACE = {"type": "string"}
_STRING_ARRAY = {"type": "array", "items": {"type": "string"}}
_DISCLOSURE = {"type": "string", "enum": ["chunk", "section", "raw"]}


def _schema(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
    *,
    additional_properties: bool = False,
) -> dict[str, Any]:
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional_properties,
    }
    if required:
        parameters["required"] = required
    return {"name": name, "description": description, "parameters": parameters}


def _legacy_schema(schema: dict[str, Any], name: str, description: str) -> dict[str, Any]:
    return {**schema, "name": name, "description": description}


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

    # -- Existing explicit tool schemas for Hermes tool registration --

    recall_schema = _schema(
        "remnic_recall",
        "Recall memories from Remnic matching a natural language query",
        {"query": {"type": "string", "description": "Natural language recall query"}},
        ["query"],
    )
    store_schema = _schema(
        "remnic_store",
        "Store a memory in Remnic for future recall",
        {"content": {"type": "string", "description": "Memory content to store"}},
        ["content"],
        additional_properties=True,
    )
    search_schema = _schema(
        "remnic_search",
        "Full-text search across all Remnic memories",
        {"query": {"type": "string", "description": "Search query"}},
        ["query"],
    )

    legacy_recall_schema = _legacy_schema(
        recall_schema,
        "engram_recall",
        "Recall memories from Engram matching a natural language query",
    )
    legacy_store_schema = _legacy_schema(
        store_schema,
        "engram_store",
        "Store a memory in Engram for future recall",
    )
    legacy_search_schema = _legacy_schema(
        search_schema,
        "engram_search",
        "Full-text search across all Engram memories",
    )

    # -- Issue #804 recall debug / explain tool schemas --

    recall_explain_schema = _schema(
        "remnic_recall_explain",
        "Return the last recall snapshot for a Hermes session or the most recent one.",
        {"sessionKey": {"type": "string"}, "namespace": _NAMESPACE},
    )
    recall_tier_explain_schema = _schema(
        "remnic_recall_tier_explain",
        "Return structured tier attribution for the last direct-answer-eligible recall.",
        {"sessionKey": {"type": "string"}, "namespace": _NAMESPACE},
    )
    recall_xray_schema = _schema(
        "remnic_recall_xray",
        "Run recall with X-ray attribution capture enabled.",
        {
            "query": {"type": "string", "description": "Query to recall against."},
            "sessionKey": {"type": "string"},
            "namespace": _NAMESPACE,
            "budget": {"type": "integer", "minimum": 1},
            "disclosure": _DISCLOSURE,
        },
        ["query"],
    )
    memory_last_recall_schema = _schema(
        "remnic_memory_last_recall",
        "Fetch the last set of memory IDs injected into context for a session.",
        {"sessionKey": {"type": "string"}},
    )
    memory_intent_debug_schema = _schema(
        "remnic_memory_intent_debug",
        "Inspect the last persisted planner/intent snapshot.",
        {"namespace": _NAMESPACE},
    )
    memory_qmd_debug_schema = _schema(
        "remnic_memory_qmd_debug",
        "Inspect the last persisted QMD recall snapshot.",
        {"namespace": _NAMESPACE},
    )
    memory_graph_explain_schema = _schema(
        "remnic_memory_graph_explain",
        "Inspect the last graph-mode recall expansion snapshot.",
        {"namespace": _NAMESPACE},
    )
    memory_feedback_last_recall_schema = _schema(
        "remnic_memory_feedback_last_recall",
        "Record relevance feedback for a memory returned by recall.",
        {
            "memoryId": {"type": "string"},
            "vote": {"type": "string", "enum": ["up", "down"]},
            "note": {"type": "string"},
        },
        ["memoryId", "vote"],
    )
    set_coding_context_schema = _schema(
        "remnic_set_coding_context",
        "Attach or clear coding context for a Hermes session.",
        {
            "sessionKey": {"type": "string"},
            "codingContext": {
                "anyOf": [
                    {"type": "null"},
                    {
                        "type": "object",
                        "properties": {
                            "projectId": {"type": "string"},
                            "branch": {"type": ["string", "null"]},
                            "rootPath": {"type": "string"},
                            "defaultBranch": {"type": ["string", "null"]},
                        },
                        "required": [
                            "projectId",
                            "branch",
                            "rootPath",
                            "defaultBranch",
                        ],
                        "additionalProperties": False,
                    },
                ]
            },
            "projectTag": {"type": "string"},
        },
        ["sessionKey"],
    )
    set_coding_context_schema["parameters"]["anyOf"] = [
        {"required": ["codingContext"]},
        {"required": ["projectTag"]},
    ]
    lcm_search_schema = _schema(
        "remnic_lcm_search",
        "Search the daemon-side Lossless Context Management conversation archive",
        {
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
        ["query"],
    )

    legacy_recall_explain_schema = _legacy_schema(
        recall_explain_schema,
        "engram_recall_explain",
        "Return the last Engram recall snapshot for a session or the most recent one.",
    )
    legacy_recall_tier_explain_schema = _legacy_schema(
        recall_tier_explain_schema,
        "engram_recall_tier_explain",
        "Return structured Engram tier attribution for the last recall.",
    )
    legacy_recall_xray_schema = _legacy_schema(
        recall_xray_schema,
        "engram_recall_xray",
        "Run Engram recall with X-ray attribution capture enabled.",
    )
    legacy_memory_last_recall_schema = _legacy_schema(
        memory_last_recall_schema,
        "engram_memory_last_recall",
        "Fetch the last set of Engram memory IDs injected into context.",
    )
    legacy_memory_intent_debug_schema = _legacy_schema(
        memory_intent_debug_schema,
        "engram_memory_intent_debug",
        "Inspect the last persisted Engram planner/intent snapshot.",
    )
    legacy_memory_qmd_debug_schema = _legacy_schema(
        memory_qmd_debug_schema,
        "engram_memory_qmd_debug",
        "Inspect the last persisted Engram QMD recall snapshot.",
    )
    legacy_memory_graph_explain_schema = _legacy_schema(
        memory_graph_explain_schema,
        "engram_memory_graph_explain",
        "Inspect the last Engram graph-mode recall expansion snapshot.",
    )
    legacy_memory_feedback_last_recall_schema = _legacy_schema(
        memory_feedback_last_recall_schema,
        "engram_memory_feedback_last_recall",
        "Record Engram relevance feedback for a memory returned by recall.",
    )
    legacy_set_coding_context_schema = _legacy_schema(
        set_coding_context_schema,
        "engram_set_coding_context",
        "Attach or clear coding context for an Engram session.",
    )
    legacy_lcm_search_schema = _legacy_schema(
        lcm_search_schema,
        "engram_lcm_search",
        "Search the daemon-side Engram Lossless Context Management conversation archive",
    )

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

    async def recall_explain(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.recall_explain(**kwargs)

    async def recall_tier_explain(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.recall_tier_explain(**kwargs)

    async def recall_xray(self, query: str, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.recall_xray(query=query, **kwargs)

    async def memory_last_recall(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_last_recall(**kwargs)

    async def memory_intent_debug(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_intent_debug(**kwargs)

    async def memory_qmd_debug(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_qmd_debug(**kwargs)

    async def memory_graph_explain(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_graph_explain(**kwargs)

    async def memory_feedback_last_recall(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_feedback_last_recall(**kwargs)

    async def set_coding_context(self, sessionKey: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.set_coding_context(sessionKey, **kwargs)


# Legacy class alias — import path compat for pre-rename consumers.
EngramMemoryProvider = RemnicMemoryProvider
