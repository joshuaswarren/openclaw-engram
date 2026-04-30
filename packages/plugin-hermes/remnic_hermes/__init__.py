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

    # Legacy tool aliases — existing Hermes configs may reference the engram_*
    # names. Keep them wired until the compat window closes.
    ctx.register_tool("engram_recall", provider.legacy_recall_schema, provider.recall)
    ctx.register_tool("engram_store", provider.legacy_store_schema, provider.store)
    ctx.register_tool("engram_search", provider.legacy_search_schema, provider.search)
    ctx.register_tool(
        "engram_lcm_search", provider.legacy_lcm_search_schema, provider.lcm_search
    )
    _register_recall_debug_tools(ctx, provider, "engram", legacy=True)
