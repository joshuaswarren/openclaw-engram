import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EngramMcpServer } from "../src/access-mcp.js";
import type { EngramAccessService } from "../src/access-service.js";

function createFakeService(): EngramAccessService {
  return {
    recall: async ({ query }) => ({
      query,
      namespace: "global",
      context: "ctx",
      count: 1,
      memoryIds: ["fact-1"],
      results: [],
      fallbackUsed: false,
      sourcesUsed: ["hot_qmd", "memories"],
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
      intent: null,
      graph: null,
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
    memoryStore: async ({ dryRun }) => ({
      schemaVersion: 1,
      operation: "memory_store",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: false,
      status: dryRun === true ? "validated" : "stored",
      memoryId: "fact-new",
    }),
    suggestionSubmit: async ({ dryRun }) => ({
      schemaVersion: 1,
      operation: "suggestion_submit",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: true,
      status: dryRun === true ? "validated" : "queued_for_review",
      memoryId: "fact-review",
    }),
    entityGet: async (name) => ({
      found: true,
      namespace: "global",
      entity: {
        name,
        type: "person",
        updated: "2026-03-08T00:00:00.000Z",
        summary: "Owns ops",
        facts: ["Maintains Engram"],
        relationships: [],
        activity: [],
        aliases: ["Alex Ops"],
      },
    }),
    reviewQueue: async () => ({
      found: true,
      runId: "gov-1",
      reviewQueue: [{ memoryId: "fact-1", reasonCode: "disputed_memory" }],
    }),
  } as unknown as EngramAccessService;
}

function parseMcpBodies(raw: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let remaining = raw;
  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    assert.notEqual(headerEnd, -1, "expected MCP header terminator");
    const header = remaining.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    assert.ok(match, "expected Content-Length header");
    const contentLength = Number.parseInt(match[1] ?? "0", 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    messages.push(JSON.parse(remaining.slice(bodyStart, bodyEnd)) as Record<string, unknown>);
    remaining = remaining.slice(bodyEnd);
  }
  return messages;
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
    "engram.memory_store",
    "engram.suggestion_submit",
    "engram.entity_get",
    "engram.review_queue_list",
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

  const store = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "engram.memory_store",
      arguments: { schemaVersion: 1, content: "A durable access-layer memory." },
    },
  });
  const storeResult = store?.result as { structuredContent: { status: string } };
  assert.equal(storeResult.structuredContent.status, "stored");

  const entity = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "engram.entity_get",
      arguments: { name: "person-alex" },
    },
  });
  const entityResult = entity?.result as { structuredContent: { entity: { name: string } } };
  assert.equal(entityResult.structuredContent.entity.name, "person-alex");
});

test("MCP server reports parse errors and keeps processing later messages", async () => {
  const server = new EngramMcpServer(createFakeService());
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk) => {
    raw += chunk.toString("utf-8");
  });

  const run = server.runStdio(input, output);
  input.write("Content-Length: 9\r\n\r\nnot-json!");
  const valid = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  input.write(`Content-Length: ${Buffer.byteLength(valid, "utf-8")}\r\n\r\n${valid}`);
  input.end();
  await run;

  assert.match(raw, /"code":-32700/);
  assert.match(raw, /engram\.recall/);
});

test("MCP server drains buffered requests in arrival order across overlapping data events", async () => {
  const seen: string[] = [];
  const service = {
    recall: async ({ query }: { query: string }) => {
      seen.push(query);
      if (query === "first") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        query,
        context: query,
        count: 1,
        memoryIds: [query],
      };
    },
  } as EngramAccessService;
  const server = new EngramMcpServer(service);
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk) => {
    raw += chunk.toString("utf-8");
  });

  const run = server.runStdio(input, output);
  const first = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "engram.recall", arguments: { query: "first" } },
  });
  const second = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "engram.recall", arguments: { query: "second" } },
  });
  input.write(`Content-Length: ${Buffer.byteLength(first, "utf-8")}\r\n\r\n${first}`);
  input.write(`Content-Length: ${Buffer.byteLength(second, "utf-8")}\r\n\r\n${second}`);
  input.end();
  await run;

  assert.deepEqual(seen, ["first", "second"]);
  const responseBodies = parseMcpBodies(raw) as Array<{
    id?: number;
    result?: { structuredContent?: { query?: string } };
  }>;
  assert.deepEqual(
    responseBodies.map((body) => body.result?.structuredContent?.query),
    ["first", "second"],
  );
});
