import test from "node:test";
import assert from "node:assert/strict";
import { EngramMcpServer } from "../src/access-mcp.js";
import type { EngramAccessService } from "../src/access-service.js";

function createFakeService(): EngramAccessService {
  return {
    recall: async ({ query }) => ({
      query,
      context: "ctx",
      count: 1,
      memoryIds: ["fact-1"],
    }),
    recallExplain: async () => ({
      found: true,
      snapshot: {
        sessionKey: "sess-1",
        recordedAt: "2026-03-08T00:00:00.000Z",
        queryHash: "hash",
        queryLen: 4,
        memoryIds: ["fact-1"],
      },
    }),
    memoryGet: async (memoryId) => ({
      found: true,
      namespace: "global",
      memory: {
        id: memoryId,
        path: "/tmp/fact-1.md",
        category: "fact",
        content: "hello",
        frontmatter: {
          id: memoryId,
          category: "fact",
          created: "2026-03-08T00:00:00.000Z",
          updated: "2026-03-08T00:00:00.000Z",
          source: "test",
          confidence: 0.9,
          confidenceTier: "implied",
          tags: [],
        },
      },
    }),
    memoryTimeline: async (memoryId) => ({
      found: true,
      namespace: "global",
      count: 1,
      timeline: [{
        eventId: "evt-1",
        memoryId,
        eventType: "created",
        timestamp: "2026-03-08T00:00:00.000Z",
        eventOrder: 1,
        actor: "engram",
        ruleVersion: "1",
      }],
    }),
  } as unknown as EngramAccessService;
}

test("MCP server advertises tools and dispatches recall", async () => {
  const server = new EngramMcpServer(createFakeService());

  const init = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.equal(init?.jsonrpc, "2.0");
  assert.equal((init?.result as { protocolVersion: string }).protocolVersion, "2024-11-05");

  const tools = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const listed = (tools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  assert.deepEqual(listed, [
    "engram.recall",
    "engram.recall_explain",
    "engram.memory_get",
    "engram.memory_timeline",
  ]);

  const recall = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "engram.recall",
      arguments: { query: "hello" },
    },
  });
  const recallResult = recall?.result as { structuredContent: { context: string; memoryIds: string[] } };
  assert.equal(recallResult.structuredContent.context, "ctx");
  assert.deepEqual(recallResult.structuredContent.memoryIds, ["fact-1"]);
});
