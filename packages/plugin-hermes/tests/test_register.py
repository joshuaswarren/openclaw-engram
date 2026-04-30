from types import SimpleNamespace
from unittest.mock import patch

from remnic_hermes import register

_RECALL_DEBUG_TOOL_SUFFIXES = [
    "recall_explain",
    "recall_tier_explain",
    "recall_xray",
    "memory_last_recall",
    "memory_intent_debug",
    "memory_qmd_debug",
    "memory_graph_explain",
    "memory_feedback_last_recall",
    "set_coding_context",
]
_CONTINUITY_IDENTITY_TOOL_SUFFIXES = [
    "continuity_audit_generate",
    "continuity_incident_open",
    "continuity_incident_close",
    "continuity_incident_list",
    "continuity_loop_add_or_update",
    "continuity_loop_review",
    "identity_anchor_get",
    "identity_anchor_update",
]
_REVIEW_SUGGESTION_TOOL_SUFFIXES = [
    "review_queue_list",
    "review_list",
    "review_resolve",
    "suggestion_submit",
]
_WORK_BOARD_TOOL_SUFFIXES = [
    "work_task",
    "work_project",
    "work_board",
]
_SHARED_CONTEXT_TOOL_SUFFIXES = [
    "shared_context_write_output",
    "shared_feedback_record",
    "shared_priorities_append",
    "shared_context_cross_signals_run",
    "shared_context_curate_daily",
]
_COMPOUNDING_TOOL_SUFFIXES = [
    "compounding_weekly_synthesize",
    "compounding_promote_candidate",
]
_COMPRESSION_GUIDELINE_TOOL_SUFFIXES = [
    "compression_guidelines_optimize",
    "compression_guidelines_activate",
]


def _populate_provider_mock(provider):  # type: ignore[no-untyped-def]
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
    for suffix in _RECALL_DEBUG_TOOL_SUFFIXES:
        setattr(provider, f"{suffix}_schema", {"name": f"remnic_{suffix}"})
        setattr(provider, f"legacy_{suffix}_schema", {"name": f"engram_{suffix}"})
        setattr(provider, suffix, object())
    for suffix in _CONTINUITY_IDENTITY_TOOL_SUFFIXES:
        setattr(provider, f"{suffix}_schema", {"name": f"remnic_{suffix}"})
        setattr(provider, f"legacy_{suffix}_schema", {"name": f"engram_{suffix}"})
        setattr(provider, suffix, object())
    for suffix in _REVIEW_SUGGESTION_TOOL_SUFFIXES:
        setattr(provider, f"{suffix}_schema", {"name": f"remnic_{suffix}"})
        setattr(provider, f"legacy_{suffix}_schema", {"name": f"engram_{suffix}"})
        setattr(provider, suffix, object())
    for suffix in _WORK_BOARD_TOOL_SUFFIXES:
        setattr(provider, f"{suffix}_schema", {"name": f"remnic_{suffix}"})
        setattr(provider, f"legacy_{suffix}_schema", {"name": f"engram_{suffix}"})
        setattr(provider, suffix, object())
    for suffix in _SHARED_CONTEXT_TOOL_SUFFIXES:
        setattr(provider, f"{suffix}_schema", {"name": f"remnic_{suffix}"})
        setattr(provider, f"legacy_{suffix}_schema", {"name": f"engram_{suffix}"})
        setattr(provider, suffix, object())
    for suffix in _COMPOUNDING_TOOL_SUFFIXES:
        setattr(provider, f"{suffix}_schema", {"name": f"remnic_{suffix}"})
        setattr(provider, f"legacy_{suffix}_schema", {"name": f"engram_{suffix}"})
        setattr(provider, suffix, object())
    for suffix in _COMPRESSION_GUIDELINE_TOOL_SUFFIXES:
        setattr(provider, f"{suffix}_schema", {"name": f"remnic_{suffix}"})
        setattr(provider, f"legacy_{suffix}_schema", {"name": f"engram_{suffix}"})
        setattr(provider, suffix, object())


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
        _populate_provider_mock(mock_provider.return_value)

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
    assert "remnic_recall_explain" in registered_tools
    assert "engram_recall_explain" in registered_tools
    assert "remnic_continuity_incident_open" in registered_tools
    assert "engram_continuity_incident_open" in registered_tools
    assert "remnic_review_queue_list" in registered_tools
    assert "engram_review_queue_list" in registered_tools
    assert "remnic_work_task" in registered_tools
    assert "engram_work_task" in registered_tools
    assert "remnic_shared_context_write_output" in registered_tools
    assert "engram_shared_context_write_output" in registered_tools
    assert "remnic_compounding_weekly_synthesize" in registered_tools
    assert "engram_compounding_weekly_synthesize" in registered_tools
    assert "remnic_compression_guidelines_optimize" in registered_tools
    assert "engram_compression_guidelines_optimize" in registered_tools


def test_register_falls_back_to_engram_config_key():
    """Legacy engram-keyed configs still reach the provider."""
    ctx = SimpleNamespace(
        config={"engram": {"token": "legacy-token", "host": "127.0.0.1"}},
        register_memory_provider=lambda provider: None,
        register_tool=lambda name, schema, handler: None,
    )

    with patch("remnic_hermes.RemnicMemoryProvider") as mock_provider:
        _populate_provider_mock(mock_provider.return_value)

        register(ctx)

    mock_provider.assert_called_once_with(
        {"token": "legacy-token", "host": "127.0.0.1"},
    )
