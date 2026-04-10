from types import SimpleNamespace
from unittest.mock import patch

from remnic_hermes import register


def test_register_prefers_remnic_config_key():
    """Hermes registration should pass remnic-keyed config to the provider."""
    ctx = SimpleNamespace(
        config={
            "remnic": {"token": "remnic-token", "host": "10.0.0.5"},
            "engram": {"token": "legacy-token", "host": "127.0.0.1"},
        },
        register_memory_provider=lambda provider: None,
        register_tool=lambda name, schema, handler: None,
    )

    with patch("remnic_hermes.EngramMemoryProvider") as mock_provider:
        provider = mock_provider.return_value
        provider.recall_schema = {}
        provider.recall = object()
        provider.store_schema = {}
        provider.store = object()
        provider.search_schema = {}
        provider.search = object()

        register(ctx)

    mock_provider.assert_called_once_with(
        {"token": "remnic-token", "host": "10.0.0.5"},
    )
