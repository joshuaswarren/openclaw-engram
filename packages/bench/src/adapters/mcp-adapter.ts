/**
 * MCP HTTP adapter (Option B).
 * Connects to a running Engram HTTP server for evaluation.
 * Activated via --mcp flag.
 */

import type {
  MemorySystem,
  Message,
  SearchResult,
  MemoryStats,
} from "./types.js";

export interface McpAdapterOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
}

async function mcpRequest(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
  options: { authToken?: string; timeoutMs?: number },
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.authToken) {
    headers["Authorization"] = `Bearer ${options.authToken}`;
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30_000,
  );

  try {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) {
      throw new Error(`MCP RPC error: ${json.error.message}`);
    }
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createMcpAdapter(
  options: McpAdapterOptions,
): Promise<MemorySystem> {
  const { baseUrl, authToken, timeoutMs } = options;
  const rpcOpts = { authToken, timeoutMs };

  // Health check
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `Cannot connect to Engram MCP server at ${baseUrl}: ${err instanceof Error ? err.message : err}`,
    );
  }

  return {
    async store(sessionId: string, messages: Message[]): Promise<void> {
      await mcpRequest(baseUrl, "engram.lcm.observe", { sessionId, messages }, rpcOpts);
    },

    async recall(sessionId: string, query: string, budgetChars?: number): Promise<string> {
      const result = await mcpRequest(
        baseUrl,
        "engram.lcm.recall",
        { sessionId, query, budgetChars: budgetChars ?? 32000 },
        rpcOpts,
      );
      return typeof result === "string" ? result : JSON.stringify(result);
    },

    async search(
      query: string,
      limit: number,
      sessionId?: string,
    ): Promise<SearchResult[]> {
      const result = await mcpRequest(
        baseUrl,
        "engram.lcm.search",
        { query, limit, sessionId },
        rpcOpts,
      );
      if (!Array.isArray(result)) return [];
      return (result as Array<Record<string, unknown>>).map((r) => ({
        turnIndex: typeof r.turn_index === "number" ? r.turn_index : 0,
        role: typeof r.role === "string" ? r.role : "unknown",
        snippet: typeof r.snippet === "string" ? r.snippet : "",
        sessionId: typeof r.session_id === "string" ? r.session_id : "",
      }));
    },

    async reset(_sessionId?: string): Promise<void> {
      // MCP adapter can't easily reset server state.
      // Log a warning — benchmark should use unique session IDs instead.
      console.warn("[mcp-adapter] reset() is a no-op in MCP mode; use unique session IDs per run");
    },

    async getStats(sessionId?: string): Promise<MemoryStats> {
      const result = await mcpRequest(
        baseUrl,
        "engram.lcm.stats",
        { sessionId },
        rpcOpts,
      );
      const r = result as Record<string, unknown> | null;
      return {
        totalMessages: typeof r?.totalMessages === "number" ? r.totalMessages : 0,
        totalSummaryNodes: typeof r?.totalSummaryNodes === "number" ? r.totalSummaryNodes : 0,
        maxDepth: typeof r?.maxDepth === "number" ? r.maxDepth : -1,
      };
    },

    async destroy(): Promise<void> {
      // Nothing to clean up for HTTP adapter
    },
  };
}
