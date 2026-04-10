"""Tests for the EngramClient HTTP methods."""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from remnic_hermes.client import EngramClient


@pytest.fixture
def client():
    """Create a client with test config."""
    return EngramClient(host="127.0.0.1", port=4318, token="test-token", client_id="hermes")


class TestClientInit:
    def test_base_url(self, client):
        assert client.base_url == "http://127.0.0.1:4318/engram/v1"

    def test_token_set(self, client):
        assert client.token == "test-token"

    def test_client_id(self, client):
        assert client.client_id == "hermes"


class TestClientClose:
    @pytest.mark.asyncio
    async def test_close_calls_aclose(self, client):
        client._http = MagicMock()
        client._http.aclose = AsyncMock()
        await client.close()
        client._http.aclose.assert_awaited_once()
