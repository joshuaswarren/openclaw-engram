"""Async HTTP client for the Remnic memory API."""

from __future__ import annotations

from typing import Any

import httpx


class RemnicClient:
    """Typed async HTTP client for the Remnic daemon.

    NOTE: HTTP paths and the client-id header still use the legacy ``engram``
    prefix because the server exposes the legacy surface for the v1.x compat
    window. These will switch to a ``/remnic/v1`` surface once the daemon ships
    the dual-path rollout.
    """

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = 4318,
        token: str = "",
        client_id: str = "hermes",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = f"http://{host}:{port}/engram/v1"
        self.mcp_url = f"http://{host}:{port}/mcp"
        self.token = token
        self.client_id = client_id
        self._mcp_request_id = 0
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "X-Engram-Client-Id": client_id,
            },
        )

    async def _mcp_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self._mcp_request_id += 1
        resp = await self._http.post(
            self.mcp_url,
            json={
                "jsonrpc": "2.0",
                "id": self._mcp_request_id,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": arguments,
                },
            },
        )
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def recall(
        self,
        query: str,
        *,
        session_key: str = "",
        top_k: int = 8,
        mode: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "query": query,
            "sessionKey": session_key,
            "topK": top_k,
        }
        if mode:
            body["mode"] = mode
        resp = await self._http.post(
            "/recall",
            json=body,
        )
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def observe(
        self,
        session_key: str,
        messages: list[dict[str, str]],
    ) -> dict[str, Any]:
        resp = await self._http.post(
            "/observe",
            json={"sessionKey": session_key, "messages": messages},
        )
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        resp = await self._http.post("/memories", json={"content": content, **kwargs})
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def search(self, query: str, *, top_k: int = 10) -> dict[str, Any]:
        resp = await self._http.post("/search", json={"query": query, "topK": top_k})
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def lcm_search(
        self,
        query: str,
        *,
        session_key: str = "",
        namespace: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"query": query}
        if session_key:
            body["sessionKey"] = session_key
        if namespace:
            body["namespace"] = namespace
        if limit is not None:
            body["limit"] = limit
        resp = await self._http.post("/lcm/search", json=body)
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def recall_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.recall_explain", kwargs)

    async def recall_tier_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.recall_tier_explain", kwargs)

    async def recall_xray(self, query: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.recall_xray", {"query": query, **kwargs})

    async def memory_last_recall(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_last_recall", kwargs)

    async def memory_intent_debug(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_intent_debug", kwargs)

    async def memory_qmd_debug(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_qmd_debug", kwargs)

    async def memory_graph_explain(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_graph_explain", kwargs)

    async def memory_feedback_last_recall(self, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool("engram.memory_feedback", kwargs)

    async def set_coding_context(self, session_key: str, **kwargs: Any) -> dict[str, Any]:
        return await self._mcp_tool(
            "engram.set_coding_context",
            {"sessionKey": session_key, **kwargs},
        )

    async def health(self) -> dict[str, Any]:
        resp = await self._http.get("/health")
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]

    async def close(self) -> None:
        await self._http.aclose()


# Legacy class alias — import path compat for pre-rename consumers.
EngramClient = RemnicClient
