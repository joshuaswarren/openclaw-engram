import test from "node:test";
import assert from "node:assert/strict";
import { EngramAccessHttpServer } from "../src/access-http.js";
import type { EngramAccessService } from "../src/access-service.js";

function createFakeService(): EngramAccessService {
  return {
    health: async () => ({
      ok: true,
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledgeEnabled: false,
      projectionAvailable: true,
    }),
    recall: async ({ query, sessionKey }) => ({
      query,
      sessionKey,
      context: "memory context",
      count: 1,
      memoryIds: ["fact-1"],
      recordedAt: "2026-03-08T00:00:00.000Z",
    }),
    recallExplain: async ({ sessionKey }) => ({
      found: true,
      snapshot: {
        sessionKey: sessionKey ?? "default",
        recordedAt: "2026-03-08T00:00:00.000Z",
        queryHash: "hash",
        queryLen: 12,
        memoryIds: ["fact-1"],
      },
    }),
    memoryGet: async (memoryId) => ({
      found: true,
      namespace: "global",
      memory: {
        id: memoryId,
        path: "/tmp/engram/facts/fact-1.md",
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
    memoryTimeline: async (memoryId, _namespace, limit) => ({
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

test("access HTTP server enforces bearer auth and serves phase 1 routes", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const denied = await fetch(`${base}/engram/v1/health`);
    assert.equal(denied.status, 401);

    const headers = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };

    const healthRes = await fetch(`${base}/engram/v1/health`, { headers });
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json() as { ok: boolean; projectionAvailable: boolean };
    assert.equal(health.ok, true);
    assert.equal(health.projectionAvailable, true);

    const recallRes = await fetch(`${base}/engram/v1/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "what did we decide?", sessionKey: "sess-1" }),
    });
    assert.equal(recallRes.status, 200);
    const recall = await recallRes.json() as { context: string; memoryIds: string[] };
    assert.equal(recall.context, "memory context");
    assert.deepEqual(recall.memoryIds, ["fact-1"]);

    const explainRes = await fetch(`${base}/engram/v1/recall/explain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionKey: "sess-1" }),
    });
    assert.equal(explainRes.status, 200);
    const explain = await explainRes.json() as { found: boolean; snapshot: { sessionKey: string } };
    assert.equal(explain.found, true);
    assert.equal(explain.snapshot.sessionKey, "sess-1");

    const memoryRes = await fetch(`${base}/engram/v1/memories/fact-1`, { headers });
    assert.equal(memoryRes.status, 200);
    const memory = await memoryRes.json() as { found: boolean; memory: { id: string } };
    assert.equal(memory.found, true);
    assert.equal(memory.memory.id, "fact-1");

    const timelineRes = await fetch(`${base}/engram/v1/memories/fact-1/timeline?limit=5`, { headers });
    assert.equal(timelineRes.status, 200);
    const timeline = await timelineRes.json() as { count: number };
    assert.equal(timeline.count, 1);
  } finally {
    await server.stop();
  }
});

test("access HTTP server rejects oversized JSON bodies", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 32,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/recall`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "x".repeat(200) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await server.stop();
  }
});
