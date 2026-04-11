"""Tests for the RemnicMemoryProvider lifecycle and methods."""

import pytest
from unittest.mock import AsyncMock, patch

from remnic_hermes import EngramMemoryProvider
from remnic_hermes.provider import RemnicMemoryProvider


@pytest.fixture
def provider():
    """Create a provider with test config."""
    return RemnicMemoryProvider({"host": "127.0.0.1", "port": 4318, "token": "test-token"})


class TestProviderLifecycle:
    @pytest.mark.asyncio
    async def test_initialize_creates_client(self, provider):
        """initialize() should create a RemnicClient."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            await provider.initialize()
            MockClient.assert_called_once()
            instance.health.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_shutdown_closes_client(self, provider):
        """shutdown() should close the HTTP client."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
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
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.recall = AsyncMock()
            await provider.initialize()
            result = await provider.pre_llm_call([{"role": "user", "content": "hi"}])
            assert result == ""
            instance.recall.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_injects_remnic_memory_block(self, provider):
        """pre_llm_call wraps recalled context in a <remnic-memory> block."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
            instance = MockClient.return_value
            instance.health = AsyncMock()
            instance.recall = AsyncMock(return_value={"context": "prior memories", "count": 3})
            await provider.initialize()
            result = await provider.pre_llm_call(
                [{"role": "user", "content": "what did we decide last week"}]
            )
            assert result.startswith('<remnic-memory count="3">')
            assert "prior memories" in result
            assert result.endswith("</remnic-memory>")


class TestSyncTurn:
    @pytest.mark.asyncio
    async def test_no_op_without_client(self, provider):
        """sync_turn is a no-op before initialize."""
        await provider.sync_turn([{"role": "user", "content": "test"}])

    @pytest.mark.asyncio
    async def test_sends_recent_messages(self, provider):
        """sync_turn sends last 2 messages to observe endpoint."""
        with patch("remnic_hermes.provider.RemnicClient") as MockClient:
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


class TestLegacyAlias:
    def test_engram_memory_provider_is_alias(self):
        """The legacy EngramMemoryProvider name resolves to RemnicMemoryProvider."""
        assert EngramMemoryProvider is RemnicMemoryProvider
