from types import SimpleNamespace
from unittest.mock import patch

from remnic_hermes import register


def test_register_prefers_remnic_config_key():
    """Hermes registration should pass remnic-keyed config to the provider."""
    registered_tools: list[str] = []
    ctx = SimpleNamespace(
        config={
            "remnic": {"token": "remnic-token", "host": "10.0.0.5"},
            "engram": {"token": "legacy-token", "host": "127.0.0.1"},
        },
        register_memory_provider=lambda provider: None,
        register_tool=lambda name, schema, handler: registered_tools.append(name),
    )

    with patch("remnic_hermes.RemnicMemoryProvider") as mock_provider:
        provider = mock_provider.return_value
        provider.recall_schema = {"name": "remnic_recall"}
        provider.legacy_recall_schema = {"name": "engram_recall"}
        provider.recall = object()
        provider.store_schema = {"name": "remnic_store"}
        provider.legacy_store_schema = {"name": "engram_store"}
        provider.store = object()
        provider.search_schema = {"name": "remnic_search"}
        provider.legacy_search_schema = {"name": "engram_search"}
        provider.search = object()
        provider.lcm_search_schema = {"name": "remnic_lcm_search"}
        provider.legacy_lcm_search_schema = {"name": "engram_lcm_search"}
        provider.lcm_search = object()

        register(ctx)

    mock_provider.assert_called_once_with(
        {"token": "remnic-token", "host": "10.0.0.5"},
    )
    # Both primary and legacy tool names must be registered during the compat window.
    assert "remnic_recall" in registered_tools
    assert "remnic_store" in registered_tools
    assert "remnic_search" in registered_tools
    assert "remnic_lcm_search" in registered_tools
    assert "engram_recall" in registered_tools
    assert "engram_store" in registered_tools
    assert "engram_search" in registered_tools
    assert "engram_lcm_search" in registered_tools


def test_register_falls_back_to_engram_config_key():
    """Legacy engram-keyed configs still reach the provider."""
    ctx = SimpleNamespace(
        config={"engram": {"token": "legacy-token", "host": "127.0.0.1"}},
        register_memory_provider=lambda provider: None,
        register_tool=lambda name, schema, handler: None,
    )

    with patch("remnic_hermes.RemnicMemoryProvider") as mock_provider:
        provider = mock_provider.return_value
        provider.recall_schema = {}
        provider.legacy_recall_schema = {}
        provider.recall = object()
        provider.store_schema = {}
        provider.legacy_store_schema = {}
        provider.store = object()
        provider.search_schema = {}
        provider.legacy_search_schema = {}
        provider.search = object()
        provider.lcm_search_schema = {}
        provider.legacy_lcm_search_schema = {}
        provider.lcm_search = object()

        register(ctx)

    mock_provider.assert_called_once_with(
        {"token": "legacy-token", "host": "127.0.0.1"},
    )
