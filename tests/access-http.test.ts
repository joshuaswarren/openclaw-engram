import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EngramAccessHttpServer } from "../src/access-http.js";
import { EngramAccessInputError, type EngramAccessService } from "../src/access-service.js";

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
    memoryBrowse: async () => ({
      namespace: "global",
      total: 1,
      count: 1,
      limit: 50,
      offset: 0,
      memories: [{
        id: "fact-1",
        path: "/tmp/engram/facts/fact-1.md",
        category: "fact",
        status: "pending_review",
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T00:00:00.000Z",
        tags: ["ops"],
        preview: "hello",
      }],
    }),
    entityList: async () => ({
      namespace: "global",
      total: 1,
      count: 1,
      limit: 50,
      offset: 0,
      entities: [{
        name: "person-alex",
        type: "person",
        updated: "2026-03-08T00:00:00.000Z",
        summary: "Owns ops",
        aliases: ["Alex Ops"],
      }],
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
      summary: { runId: "gov-1", mode: "shadow" },
      metrics: { reviewReasons: { disputed_memory: 1 }, proposedStatuses: { pending_review: 1 } },
      reviewQueue: [{ memoryId: "fact-1", reasonCode: "disputed_memory" }],
      appliedActions: [],
      report: "# report",
    }),
    maintenance: async () => ({
      health: {
        ok: true,
        memoryDir: "/tmp/engram",
        namespacesEnabled: true,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledgeEnabled: false,
        projectionAvailable: true,
      },
      latestGovernanceRun: {
        found: true,
        runId: "gov-1",
      },
    }),
    reviewDisposition: async ({ memoryId, status }) => ({
      ok: true,
      namespace: "global",
      memoryId,
      status,
      previousStatus: "pending_review",
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

    const browseRes = await fetch(`${base}/engram/v1/memories?q=hello`, { headers });
    assert.equal(browseRes.status, 200);
    const browse = await browseRes.json() as { total: number };
    assert.equal(browse.total, 1);

    const entitiesRes = await fetch(`${base}/engram/v1/entities?q=alex`, { headers });
    assert.equal(entitiesRes.status, 200);
    const entities = await entitiesRes.json() as { total: number };
    assert.equal(entities.total, 1);

    const entityRes = await fetch(`${base}/engram/v1/entities/person-alex`, { headers });
    assert.equal(entityRes.status, 200);
    const entity = await entityRes.json() as { found: boolean; entity: { name: string } };
    assert.equal(entity.found, true);
    assert.equal(entity.entity.name, "person-alex");

    const queueRes = await fetch(`${base}/engram/v1/review-queue`, { headers });
    assert.equal(queueRes.status, 200);
    const queue = await queueRes.json() as { found: boolean; runId: string };
    assert.equal(queue.found, true);
    assert.equal(queue.runId, "gov-1");

    const maintenanceRes = await fetch(`${base}/engram/v1/maintenance`, { headers });
    assert.equal(maintenanceRes.status, 200);
    const maintenance = await maintenanceRes.json() as { latestGovernanceRun: { runId: string } };
    assert.equal(maintenance.latestGovernanceRun.runId, "gov-1");

    const dispositionRes = await fetch(`${base}/engram/v1/review-disposition`, {
      method: "POST",
      headers,
      body: JSON.stringify({ memoryId: "fact-1", status: "active", reasonCode: "operator_confirmed" }),
    });
    assert.equal(dispositionRes.status, 200);
    const disposition = await dispositionRes.json() as { ok: boolean; status: string };
    assert.equal(disposition.ok, true);
    assert.equal(disposition.status, "active");
  } finally {
    await server.stop();
  }
});

test("access HTTP server serves admin console shell without auth and rejects invalid dispositions", async () => {
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
    const uiRes = await fetch(`${base}/engram/ui/`);
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.match(html, /Engram Admin Console/);

    const badDispositionRes = await fetch(`${base}/engram/v1/review-disposition`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ memoryId: "fact-1", status: "bogus", reasonCode: "operator_confirmed" }),
    });
    assert.equal(badDispositionRes.status, 400);
  } finally {
    await server.stop();
  }
});

test("access HTTP server resolves the admin console shell independently of cwd", async () => {
  const originalCwd = process.cwd();
  const tempCwd = await mkdtemp(path.join(os.tmpdir(), "engram-access-http-cwd-"));
  process.chdir(tempCwd);

  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });

  try {
    const started = await server.start();
    const base = `http://${started.host}:${started.port}`;
    const uiRes = await fetch(`${base}/engram/ui/`);
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.match(html, /Engram Admin Console/);
  } finally {
    await server.stop();
    process.chdir(originalCwd);
    await rm(tempCwd, { recursive: true, force: true });
  }
});

test("access HTTP server returns an empty review queue payload with 200", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      reviewQueue: async () => ({ found: false }),
    } as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/review-queue`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { found: boolean };
    assert.equal(payload.found, false);
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

test("access HTTP server returns 400 for empty recall query", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      recall: async ({ query }: { query: string }) => {
        if (query.trim().length === 0) throw new EngramAccessInputError("query is required");
        return { query, context: "ctx", count: 0, memoryIds: [] };
      },
      health: async () => ({ ok: true }),
      recallExplain: async () => ({ found: false }),
      memoryGet: async () => ({ found: false, namespace: "global" }),
      memoryTimeline: async () => ({ found: false, namespace: "global", count: 0, timeline: [] }),
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
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
      body: JSON.stringify({ query: "   " }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.equal(body.error, "query is required");
  } finally {
    await server.stop();
  }
});
