"""Engram MemoryProvider plugin for Hermes Agent."""

from remnic_hermes.provider import EngramMemoryProvider

__all__ = ["EngramMemoryProvider", "register"]


def register(ctx):  # type: ignore[no-untyped-def]
    """Hermes plugin entry point. Registers the MemoryProvider and explicit tools."""
    config = ctx.config.get("remnic")
    if not isinstance(config, dict):
        config = ctx.config.get("engram", {})
    provider = EngramMemoryProvider(config)
    ctx.register_memory_provider(provider)
    ctx.register_tool("engram_recall", provider.recall_schema, provider.recall)
    ctx.register_tool("engram_store", provider.store_schema, provider.store)
    ctx.register_tool("engram_search", provider.search_schema, provider.search)
