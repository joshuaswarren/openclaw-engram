"""Tests for the EngramMemoryProvider lifecycle and methods."""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from remnic_hermes.provider import EngramMemoryProvider


@pytest.fixture
def provider():
    """Create a provider with test config."""
    return EngramMemoryProvider({"host": "127.0.0.1", "port": 4318, "token": "test-token"})


class TestProviderLifecycle:
    @pytest.mark.asyncio
    async def test_initialize_creates_client(self, provider):
        """initialize() should create an EngramClient."""
        with patch("remnic_hermes.provider.EngramClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            await provider.initialize()
            MockClient.assert_called_once()
            instance.health.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_shutdown_closes_client(self, provider):
        """shutdown() should close the HTTP client."""
        with patch("remnic_hermes.provider.EngramClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.close = AsyncMock()
            await provider.initialize()
            await provider.shutdown()
            instance.close.assert_awaited_once()


class TestPreLlmCall:
    @pytest.mark.asyncio
    async def test_returns_empty_without_client(self, provider):
        """pre_llm_call returns empty string when not initialized."""
        result = await provider.pre_llm_call([{"role": "user", "content": "test query here"}])
        assert result == ""

    @pytest.mark.asyncio
    async def test_skips_short_queries(self, provider):
        """pre_llm_call skips queries shorter than 3 words."""
        with patch("remnic_hermes.provider.EngramClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.recall = AsyncMock()
            await provider.initialize()
            result = await provider.pre_llm_call([{"role": "user", "content": "hi"}])
            assert result == ""
            instance.recall.assert_not_awaited()


class TestSyncTurn:
    @pytest.mark.asyncio
    async def test_no_op_without_client(self, provider):
        """sync_turn is a no-op before initialize."""
        await provider.sync_turn([{"role": "user", "content": "test"}])

    @pytest.mark.asyncio
    async def test_sends_recent_messages(self, provider):
        """sync_turn sends last 2 messages to observe endpoint."""
        with patch("remnic_hermes.provider.EngramClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.observe = AsyncMock(return_value={})
            await provider.initialize()
            messages = [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "reply1"},
                {"role": "user", "content": "second"},
                {"role": "assistant", "content": "reply2"},
            ]
            await provider.sync_turn(messages)
            instance.observe.assert_awaited_once()
            call_args = instance.observe.call_args
            assert len(call_args.kwargs["messages"]) == 2
