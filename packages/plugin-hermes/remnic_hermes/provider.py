"""Remnic MemoryProvider protocol implementation for Hermes Agent."""

from __future__ import annotations

import uuid
from typing import Any

from remnic_hermes.client import RemnicClient
from remnic_hermes.config import RemnicHermesConfig


_NAMESPACE = {"type": "string"}
_STRING_ARRAY = {"type": "array", "items": {"type": "string"}}
_DISCLOSURE = {"type": "string", "enum": ["chunk", "section", "raw"]}
_MEMORY_CATEGORY = {
    "type": "string",
    "enum": [
        "fact",
        "preference",
        "correction",
        "entity",
        "decision",
        "relationship",
        "principle",
        "commitment",
        "moment",
        "skill",
        "rule",
        "procedure",
        "reasoning_trace",
    ],
}
_ACTION_TYPES = [
    "store_episode",
    "store_note",
    "update_note",
    "create_artifact",
    "summarize_node",
    "discard",
    "link_graph",
]


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
    """MemoryProvider that delegates to the Remnic daemon via HTTP."""

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
            pass  # Non-fatal — daemon might start later.

    async def pre_llm_call(self, messages: list[dict[str, str]]) -> str:
        """Recall relevant memories and return context to inject into system prompt."""
        if not self._client:
            return ""

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

    # -- Issue #805 memory CRUD / inspection tool schemas --

    memory_get_schema = _schema(
        "remnic_memory_get",
        "Fetch one stored memory by id.",
        {"memoryId": {"type": "string"}, "namespace": _NAMESPACE},
        ["memoryId"],
    )
    memory_store_schema = _schema(
        "remnic_memory_store",
        "Store a memory with the daemon's rich memory_store schema.",
        {
            "schemaVersion": {"type": "number"},
            "idempotencyKey": {"type": "string"},
            "dryRun": {"type": "boolean"},
            "sessionKey": {"type": "string"},
            "content": {"type": "string"},
            "category": {"type": "string"},
            "confidence": {"type": "number"},
            "namespace": _NAMESPACE,
            "tags": _STRING_ARRAY,
            "entityRef": {"type": "string"},
            "ttl": {"type": "string"},
            "sourceReason": {"type": "string"},
        },
        ["content"],
    )
    memory_timeline_schema = _schema(
        "remnic_memory_timeline",
        "Read the event timeline for a stored memory.",
        {"memoryId": {"type": "string"}, "namespace": _NAMESPACE, "limit": {"type": "number"}},
        ["memoryId"],
    )
    memory_profile_schema = _schema(
        "remnic_memory_profile",
        "Read the user's behavioral profile.",
        {"namespace": _NAMESPACE},
    )
    memory_entities_schema = _schema(
        "remnic_memory_entities",
        "List tracked entities.",
        {"namespace": _NAMESPACE},
    )
    memory_questions_schema = _schema(
        "remnic_memory_questions",
        "List open memory questions.",
        {"namespace": _NAMESPACE},
    )
    memory_identity_schema = _schema(
        "remnic_memory_identity",
        "Read identity memory state.",
        {"namespace": _NAMESPACE},
    )
    memory_promote_schema = _schema(
        "remnic_memory_promote",
        "Promote a memory candidate or review item.",
        {
            "memoryId": {"type": "string"},
            "namespace": _NAMESPACE,
            "sessionKey": {"type": "string"},
        },
        ["memoryId"],
    )
    memory_outcome_schema = _schema(
        "remnic_memory_outcome",
        "Record or inspect an outcome for a memory action.",
        {
            "memoryId": {"type": "string"},
            "outcome": {"type": "string", "enum": ["success", "failure"]},
            "namespace": _NAMESPACE,
            "sessionKey": {"type": "string"},
            "timestamp": {
                "type": "string",
                "description": "Optional ISO-8601 timestamp of the observation.",
            },
        },
        ["memoryId", "outcome"],
    )
    entity_get_schema = _schema(
        "remnic_entity_get",
        "Fetch one tracked entity by name.",
        {"name": {"type": "string"}, "namespace": _NAMESPACE},
        ["name"],
    )
    memory_capture_schema = _schema(
        "remnic_memory_capture",
        "Capture an explicit memory using the OpenClaw memory_capture surface.",
        {
            "content": {"type": "string"},
            "namespace": _NAMESPACE,
            "category": _MEMORY_CATEGORY,
            "tags": _STRING_ARRAY,
            "entityRef": {"type": "string"},
            "confidence": {"type": "number"},
            "ttl": {"type": "string"},
            "sourceReason": {"type": "string"},
        },
        ["content"],
    )
    memory_action_apply_schema = _schema(
        "remnic_memory_action_apply",
        "Apply a memory action using the OpenClaw memory_action_apply surface.",
        {
            "action": {
                "type": "string",
                "enum": _ACTION_TYPES,
            },
            "category": _MEMORY_CATEGORY,
            "content": {"type": "string"},
            "outcome": {"type": "string", "enum": ["applied", "skipped", "failed"]},
            "reason": {"type": "string"},
            "memoryId": {"type": "string"},
            "sessionKey": {"type": "string"},
            "linkTargetId": {"type": "string"},
            "linkType": {"type": "string"},
            "linkStrength": {"type": "number"},
            "artifactType": {"type": "string"},
            "execute": {"type": "boolean"},
            "sourcePrompt": {"type": "string"},
            "namespace": _NAMESPACE,
            "dryRun": {"type": "boolean"},
        },
        ["action"],
    )

    legacy_memory_get_schema = _legacy_schema(memory_get_schema, "engram_memory_get", "Fetch one Engram memory by id.")
    legacy_memory_store_schema = _legacy_schema(memory_store_schema, "engram_memory_store", "Store a memory in Engram.")
    legacy_memory_timeline_schema = _legacy_schema(
        memory_timeline_schema,
        "engram_memory_timeline",
        "Read an Engram memory timeline.",
    )
    legacy_memory_profile_schema = _legacy_schema(
        memory_profile_schema,
        "engram_memory_profile",
        "Read the Engram behavioral profile.",
    )
    legacy_memory_entities_schema = _legacy_schema(
        memory_entities_schema,
        "engram_memory_entities",
        "List Engram tracked entities.",
    )
    legacy_memory_questions_schema = _legacy_schema(
        memory_questions_schema,
        "engram_memory_questions",
        "List Engram memory questions.",
    )
    legacy_memory_identity_schema = _legacy_schema(
        memory_identity_schema,
        "engram_memory_identity",
        "Read Engram identity memory state.",
    )
    legacy_memory_promote_schema = _legacy_schema(
        memory_promote_schema,
        "engram_memory_promote",
        "Promote an Engram memory candidate.",
    )
    legacy_memory_outcome_schema = _legacy_schema(
        memory_outcome_schema,
        "engram_memory_outcome",
        "Record or inspect an Engram memory outcome.",
    )
    legacy_entity_get_schema = _legacy_schema(entity_get_schema, "engram_entity_get", "Fetch one Engram tracked entity by name.")
    legacy_memory_capture_schema = _legacy_schema(memory_capture_schema, "engram_memory_capture", "Capture an explicit Engram memory.")
    legacy_memory_action_apply_schema = _legacy_schema(
        memory_action_apply_schema,
        "engram_memory_action_apply",
        "Apply an Engram memory action.",
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

    async def memory_get(self, memoryId: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_get(memoryId, **kwargs)

    async def memory_store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        session_key = kwargs.pop("sessionKey", self._session_key)
        return await self._client.memory_store(content=content, sessionKey=session_key, **kwargs)

    async def memory_timeline(self, memoryId: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_timeline(memoryId, **kwargs)

    async def memory_profile(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_profile(**kwargs)

    async def memory_entities(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_entities(**kwargs)

    async def memory_questions(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_questions(**kwargs)

    async def memory_identity(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_identity(**kwargs)

    async def memory_promote(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_promote(**kwargs)

    async def memory_outcome(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_outcome(**kwargs)

    async def entity_get(self, name: str, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.entity_get(name, **kwargs)

    async def memory_capture(self, content: str, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_capture(content=content, **kwargs)

    async def memory_action_apply(self, action: str, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.memory_action_apply(action=action, **kwargs)


# Legacy class alias — import path compat for pre-rename consumers.
EngramMemoryProvider = RemnicMemoryProvider
