"""Remnic MemoryProvider plugin for Hermes Agent."""

from remnic_hermes.client import RemnicClient
from remnic_hermes.config import RemnicHermesConfig
from remnic_hermes.provider import RemnicMemoryProvider

# Legacy aliases — preserved for the Engram → Remnic compat window.
# These will be removed in a future major release.
EngramMemoryProvider = RemnicMemoryProvider
EngramClient = RemnicClient
EngramHermesConfig = RemnicHermesConfig

__all__ = [
    "RemnicMemoryProvider",
    "RemnicClient",
    "RemnicHermesConfig",
    "EngramMemoryProvider",
    "EngramClient",
    "EngramHermesConfig",
    "register",
]

_RECALL_DEBUG_TOOLS = [
    ("recall_explain", "recall_explain"),
    ("recall_tier_explain", "recall_tier_explain"),
    ("recall_xray", "recall_xray"),
    ("memory_last_recall", "memory_last_recall"),
    ("memory_intent_debug", "memory_intent_debug"),
    ("memory_qmd_debug", "memory_qmd_debug"),
    ("memory_graph_explain", "memory_graph_explain"),
    ("memory_feedback_last_recall", "memory_feedback_last_recall"),
    ("set_coding_context", "set_coding_context"),
]


def _register_recall_debug_tools(ctx, provider: RemnicMemoryProvider, prefix: str, legacy: bool = False):  # type: ignore[no-untyped-def]
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _RECALL_DEBUG_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


def _register_issue_805_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    ctx.register_tool(
        f"{prefix}_memory_get",
        getattr(provider, f"{schema_prefix}memory_get_schema"),
        provider.memory_get,
    )
    ctx.register_tool(
        f"{prefix}_memory_store",
        getattr(provider, f"{schema_prefix}memory_store_schema"),
        provider.memory_store,
    )
    ctx.register_tool(
        f"{prefix}_memory_timeline",
        getattr(provider, f"{schema_prefix}memory_timeline_schema"),
        provider.memory_timeline,
    )
    ctx.register_tool(
        f"{prefix}_memory_profile",
        getattr(provider, f"{schema_prefix}memory_profile_schema"),
        provider.memory_profile,
    )
    ctx.register_tool(
        f"{prefix}_memory_entities",
        getattr(provider, f"{schema_prefix}memory_entities_schema"),
        provider.memory_entities,
    )
    ctx.register_tool(
        f"{prefix}_memory_questions",
        getattr(provider, f"{schema_prefix}memory_questions_schema"),
        provider.memory_questions,
    )
    ctx.register_tool(
        f"{prefix}_memory_identity",
        getattr(provider, f"{schema_prefix}memory_identity_schema"),
        provider.memory_identity,
    )
    ctx.register_tool(
        f"{prefix}_memory_promote",
        getattr(provider, f"{schema_prefix}memory_promote_schema"),
        provider.memory_promote,
    )
    ctx.register_tool(
        f"{prefix}_memory_outcome",
        getattr(provider, f"{schema_prefix}memory_outcome_schema"),
        provider.memory_outcome,
    )
    ctx.register_tool(f"{prefix}_entity_get", getattr(provider, f"{schema_prefix}entity_get_schema"), provider.entity_get)
    ctx.register_tool(f"{prefix}_memory_capture", getattr(provider, f"{schema_prefix}memory_capture_schema"), provider.memory_capture)
    ctx.register_tool(
        f"{prefix}_memory_action_apply",
        getattr(provider, f"{schema_prefix}memory_action_apply_schema"),
        provider.memory_action_apply,
    )


_CONTINUITY_IDENTITY_TOOLS = [
    ("continuity_audit_generate", "continuity_audit_generate"),
    ("continuity_incident_open", "continuity_incident_open"),
    ("continuity_incident_close", "continuity_incident_close"),
    ("continuity_incident_list", "continuity_incident_list"),
    ("continuity_loop_add_or_update", "continuity_loop_add_or_update"),
    ("continuity_loop_review", "continuity_loop_review"),
    ("identity_anchor_get", "identity_anchor_get"),
    ("identity_anchor_update", "identity_anchor_update"),
]


def _register_issue_806_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _CONTINUITY_IDENTITY_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


_REVIEW_SUGGESTION_TOOLS = [
    ("review_queue_list", "review_queue_list"),
    ("review_list", "review_list"),
    ("review_resolve", "review_resolve"),
    ("suggestion_submit", "suggestion_submit"),
]


def _register_issue_807_tools(  # type: ignore[no-untyped-def]
    ctx,
    provider: RemnicMemoryProvider,
    prefix: str,
    legacy: bool = False,
):
    schema_prefix = "legacy_" if legacy else ""
    for tool_suffix, handler_name in _REVIEW_SUGGESTION_TOOLS:
        ctx.register_tool(
            f"{prefix}_{tool_suffix}",
            getattr(provider, f"{schema_prefix}{tool_suffix}_schema"),
            getattr(provider, handler_name),
        )


def register(ctx):  # type: ignore[no-untyped-def]
    """Hermes plugin entry point. Registers the MemoryProvider and explicit tools."""
    config = ctx.config.get("remnic")
    if not isinstance(config, dict):
        config = ctx.config.get("engram", {})

    provider = RemnicMemoryProvider(config)
    ctx.register_memory_provider(provider)

    # Primary tool names (Remnic-branded).
    ctx.register_tool("remnic_recall", provider.recall_schema, provider.recall)
    ctx.register_tool("remnic_store", provider.store_schema, provider.store)
    ctx.register_tool("remnic_search", provider.search_schema, provider.search)
    ctx.register_tool(
        "remnic_lcm_search", provider.lcm_search_schema, provider.lcm_search
    )
    _register_recall_debug_tools(ctx, provider, "remnic")
    _register_issue_805_tools(ctx, provider, "remnic")
    _register_issue_806_tools(ctx, provider, "remnic")
    _register_issue_807_tools(ctx, provider, "remnic")

    # Legacy tool aliases — existing Hermes configs may reference the engram_*
    # names. Keep them wired until the compat window closes.
    ctx.register_tool("engram_recall", provider.legacy_recall_schema, provider.recall)
    ctx.register_tool("engram_store", provider.legacy_store_schema, provider.store)
    ctx.register_tool("engram_search", provider.legacy_search_schema, provider.search)
    ctx.register_tool(
        "engram_lcm_search", provider.legacy_lcm_search_schema, provider.lcm_search
    )
    _register_recall_debug_tools(ctx, provider, "engram", legacy=True)
    _register_issue_805_tools(ctx, provider, "engram", legacy=True)
    _register_issue_806_tools(ctx, provider, "engram", legacy=True)
    _register_issue_807_tools(ctx, provider, "engram", legacy=True)
