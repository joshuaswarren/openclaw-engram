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
_CONTINUITY_INCIDENT_STATES = ["open", "closed", "all"]
_CONTINUITY_LOOP_CADENCES = ["daily", "weekly", "monthly", "quarterly"]
_CONTINUITY_LOOP_STATUSES = ["active", "paused", "retired"]
_REVIEW_FILTERS = ["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"]
_REVIEW_RESOLUTION_VERBS = ["keep-a", "keep-b", "merge", "both-valid", "needs-more-context"]


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

    # -- Issue #806 continuity / identity tool schemas --

    continuity_audit_generate_schema = _schema(
        "remnic_continuity_audit_generate",
        "Generate a deterministic identity continuity audit report.",
        {
            "period": {"type": "string", "enum": ["weekly", "monthly"]},
            "key": {
                "type": "string",
                "description": "Period key (weekly: YYYY-Www, monthly: YYYY-MM). Defaults to current.",
            },
        },
    )
    continuity_incident_open_schema = _schema(
        "remnic_continuity_incident_open",
        "Create a new continuity incident record in append-only storage.",
        {
            "symptom": {
                "type": "string",
                "description": "Observed continuity failure symptom.",
            },
            "namespace": _NAMESPACE,
            "triggerWindow": {
                "type": "string",
                "description": "Time window when incident occurred.",
            },
            "suspectedCause": {"type": "string"},
        },
        ["symptom"],
    )
    continuity_incident_close_schema = _schema(
        "remnic_continuity_incident_close",
        "Close an open continuity incident with verification details.",
        {
            "id": {"type": "string", "description": "Incident ID to close."},
            "namespace": _NAMESPACE,
            "fixApplied": {"type": "string", "description": "What fix was applied."},
            "verificationResult": {"type": "string", "description": "How closure was verified."},
            "preventiveRule": {"type": "string", "description": "Optional preventive follow-up rule."},
        },
        ["id", "fixApplied", "verificationResult"],
    )
    continuity_incident_list_schema = _schema(
        "remnic_continuity_incident_list",
        "List continuity incidents, optionally filtered by state.",
        {
            "state": {"type": "string", "enum": _CONTINUITY_INCIDENT_STATES},
            "namespace": _NAMESPACE,
            "limit": {
                "type": "number",
                "description": "Max incidents (default 25, max 200).",
            },
        },
    )
    continuity_loop_add_or_update_schema = _schema(
        "remnic_continuity_loop_add_or_update",
        "Add or update a continuity improvement loop entry.",
        {
            "id": {"type": "string", "description": "Stable loop identifier."},
            "cadence": {"type": "string", "enum": _CONTINUITY_LOOP_CADENCES},
            "purpose": {"type": "string", "description": "What this recurring loop improves."},
            "status": {"type": "string", "enum": _CONTINUITY_LOOP_STATUSES},
            "killCondition": {
                "type": "string",
                "description": "Clear condition for retiring this loop.",
            },
            "namespace": _NAMESPACE,
            "lastReviewed": {
                "type": "string",
                "description": "ISO timestamp for last review.",
            },
            "notes": {"type": "string"},
        },
        ["id", "cadence", "purpose", "status", "killCondition"],
    )
    continuity_loop_review_schema = _schema(
        "remnic_continuity_loop_review",
        "Update review metadata for an existing continuity improvement loop.",
        {
            "id": {"type": "string", "description": "Loop ID to review."},
            "namespace": _NAMESPACE,
            "status": {"type": "string", "enum": _CONTINUITY_LOOP_STATUSES},
            "notes": {"type": "string"},
            "reviewedAt": {
                "type": "string",
                "description": "ISO timestamp for review event.",
            },
        },
        ["id"],
    )
    identity_anchor_get_schema = _schema(
        "remnic_identity_anchor_get",
        "Read the identity continuity anchor document.",
        {"namespace": _NAMESPACE},
    )
    identity_anchor_update_schema = _schema(
        "remnic_identity_anchor_update",
        "Conservatively merge identity anchor sections without overwriting existing material.",
        {
            "namespace": _NAMESPACE,
            "identityTraits": {
                "type": "string",
                "description": "Updates for 'Identity Traits' section.",
            },
            "communicationPreferences": {
                "type": "string",
                "description": "Updates for 'Communication Preferences' section.",
            },
            "operatingPrinciples": {
                "type": "string",
                "description": "Updates for 'Operating Principles' section.",
            },
            "continuityNotes": {
                "type": "string",
                "description": "Updates for 'Continuity Notes' section.",
            },
        },
    )

    legacy_continuity_audit_generate_schema = _legacy_schema(
        continuity_audit_generate_schema,
        "engram_continuity_audit_generate",
        "Generate a deterministic Engram identity continuity audit report.",
    )
    legacy_continuity_incident_open_schema = _legacy_schema(
        continuity_incident_open_schema,
        "engram_continuity_incident_open",
        "Create a new Engram continuity incident record.",
    )
    legacy_continuity_incident_close_schema = _legacy_schema(
        continuity_incident_close_schema,
        "engram_continuity_incident_close",
        "Close an open Engram continuity incident.",
    )
    legacy_continuity_incident_list_schema = _legacy_schema(
        continuity_incident_list_schema,
        "engram_continuity_incident_list",
        "List Engram continuity incidents.",
    )
    legacy_continuity_loop_add_or_update_schema = _legacy_schema(
        continuity_loop_add_or_update_schema,
        "engram_continuity_loop_add_or_update",
        "Add or update an Engram continuity improvement loop.",
    )
    legacy_continuity_loop_review_schema = _legacy_schema(
        continuity_loop_review_schema,
        "engram_continuity_loop_review",
        "Update review metadata for an Engram continuity improvement loop.",
    )
    legacy_identity_anchor_get_schema = _legacy_schema(
        identity_anchor_get_schema,
        "engram_identity_anchor_get",
        "Read the Engram identity continuity anchor document.",
    )
    legacy_identity_anchor_update_schema = _legacy_schema(
        identity_anchor_update_schema,
        "engram_identity_anchor_update",
        "Conservatively merge Engram identity anchor sections.",
    )

    # -- Issue #807 review queue / suggestions tool schemas --

    review_queue_list_schema = _schema(
        "remnic_review_queue_list",
        "Fetch the latest review queue artifact bundle.",
        {"runId": {"type": "string"}, "namespace": _NAMESPACE},
    )
    review_list_schema = _schema(
        "remnic_review_list",
        "List contradiction review items pending user resolution.",
        {
            "filter": {
                "type": "string",
                "enum": _REVIEW_FILTERS,
                "description": "Filter by verdict type. Default: unresolved.",
            },
            "namespace": _NAMESPACE,
            "limit": {"type": "number", "description": "Max items to return (default 50)."},
        },
    )
    review_resolve_schema = _schema(
        "remnic_review_resolve",
        "Resolve a contradiction pair with a chosen verb.",
        {
            "pairId": {
                "type": "string",
                "description": "The contradiction pair ID to resolve.",
            },
            "verb": {
                "type": "string",
                "enum": _REVIEW_RESOLUTION_VERBS,
                "description": "Resolution action.",
            },
        },
        ["pairId", "verb"],
    )
    suggestion_submit_schema = _schema(
        "remnic_suggestion_submit",
        "Queue a suggested memory for review.",
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

    legacy_review_queue_list_schema = _legacy_schema(
        review_queue_list_schema,
        "engram_review_queue_list",
        "Fetch the latest Engram review queue artifact bundle.",
    )
    legacy_review_list_schema = _legacy_schema(
        review_list_schema,
        "engram_review_list",
        "List Engram contradiction review items pending user resolution.",
    )
    legacy_review_resolve_schema = _legacy_schema(
        review_resolve_schema,
        "engram_review_resolve",
        "Resolve an Engram contradiction pair with a chosen verb.",
    )
    legacy_suggestion_submit_schema = _legacy_schema(
        suggestion_submit_schema,
        "engram_suggestion_submit",
        "Queue a suggested Engram memory for review.",
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

    async def continuity_audit_generate(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.continuity_audit_generate(**kwargs)

    async def continuity_incident_open(self, symptom: str, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.continuity_incident_open(symptom=symptom, **kwargs)

    async def continuity_incident_close(
        self,
        id: str,  # noqa: A002,N803
        fixApplied: str,  # noqa: N803
        verificationResult: str,  # noqa: N803
        **kwargs: Any,
    ) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.continuity_incident_close(
            incident_id=id,
            fix_applied=fixApplied,
            verification_result=verificationResult,
            **kwargs,
        )

    async def continuity_incident_list(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.continuity_incident_list(**kwargs)

    async def continuity_loop_add_or_update(
        self,
        id: str,  # noqa: A002,N803
        cadence: str,
        purpose: str,
        status: str,
        killCondition: str,  # noqa: N803
        **kwargs: Any,
    ) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.continuity_loop_add_or_update(
            loop_id=id,
            cadence=cadence,
            purpose=purpose,
            status=status,
            kill_condition=killCondition,
            **kwargs,
        )

    async def continuity_loop_review(self, id: str, **kwargs: Any) -> dict[str, Any]:  # noqa: A002,N803
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.continuity_loop_review(loop_id=id, **kwargs)

    async def identity_anchor_get(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.identity_anchor_get(**kwargs)

    async def identity_anchor_update(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.identity_anchor_update(**kwargs)

    async def review_queue_list(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.review_queue_list(**kwargs)

    async def review_list(self, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.review_list(**kwargs)

    async def review_resolve(self, pairId: str, verb: str, **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        if not self._client:
            return {"error": "Not connected to Remnic"}
        return await self._client.review_resolve(pair_id=pairId, verb=verb)

    async def suggestion_submit(self, content: str, **kwargs: Any) -> dict[str, Any]:
        if not self._client:
            return {"error": "Not connected to Remnic"}
        session_key = kwargs.pop("sessionKey", self._session_key)
        return await self._client.suggestion_submit(content=content, sessionKey=session_key, **kwargs)


# Legacy class alias — import path compat for pre-rename consumers.
EngramMemoryProvider = RemnicMemoryProvider
