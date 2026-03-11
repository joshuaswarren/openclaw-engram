import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EngramAccessHttpServer } from "../src/access-http.js";
import { EngramAccessInputError, EngramAccessService, type EngramAccessService } from "../src/access-service.js";
import { StorageManager } from "../src/storage.js";

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
      namespace: "global",
      context: "memory context",
      count: 1,
      memoryIds: ["fact-1"],
      results: [{
        id: "fact-1",
        path: "/tmp/engram/facts/fact-1.md",
        category: "fact",
        status: "active",
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T00:00:00.000Z",
        tags: ["ops"],
        preview: "hello",
      }],
      recordedAt: "2026-03-08T00:00:00.000Z",
      traceId: "trace-1",
      plannerMode: "full",
      fallbackUsed: false,
      sourcesUsed: ["hot_qmd", "memories"],
      budgetsApplied: {
        appliedTopK: 1,
        recallBudgetChars: 8000,
        maxMemoryTokens: 2000,
      },
      latencyMs: 12,
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
      intent: null,
      graph: null,
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
    memoryStore: async ({ dryRun, idempotencyKey }) => ({
      schemaVersion: 1,
      operation: "memory_store",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: false,
      status: dryRun === true ? "validated" : "stored",
      memoryId: dryRun === true ? undefined : "fact-new",
      idempotencyKey,
    }),
    suggestionSubmit: async ({ dryRun, idempotencyKey }) => ({
      schemaVersion: 1,
      operation: "suggestion_submit",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: true,
      status: dryRun === true ? "validated" : "queued_for_review",
      memoryId: dryRun === true ? undefined : "fact-review",
      idempotencyKey,
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
    assert.equal((recall as { traceId?: string }).traceId, "trace-1");

    const explainRes = await fetch(`${base}/engram/v1/recall/explain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionKey: "sess-1", namespace: "global" }),
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

    const storeRes = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        idempotencyKey: "store-1",
        content: "A durable explicit memory for the access API.",
        category: "fact",
      }),
    });
    assert.equal(storeRes.status, 201);
    const storePayload = await storeRes.json() as { operation: string; status: string; idempotencyKey: string };
    assert.equal(storePayload.operation, "memory_store");
    assert.equal(storePayload.status, "stored");
    assert.equal(storePayload.idempotencyKey, "store-1");

    const suggestionRes = await fetch(`${base}/engram/v1/suggestions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "This should be queued for review.",
        category: "fact",
      }),
    });
    assert.equal(suggestionRes.status, 201);
    const suggestionPayload = await suggestionRes.json() as { operation: string; status: string; queued: boolean };
    assert.equal(suggestionPayload.operation, "suggestion_submit");
    assert.equal(suggestionPayload.status, "queued_for_review");
    assert.equal(suggestionPayload.queued, true);

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

test("access HTTP server rate-limits write endpoints", async () => {
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
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          content: `A durable memory payload for write limiter coverage ${index}.`,
          category: "fact",
        }),
      });
      assert.equal(response.status, 201);
    }
    const limited = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "A durable memory payload for rate-limit overflow.",
        category: "fact",
      }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await server.stop();
  }
});

test("access HTTP server does not consume the write rate limit for invalid requests", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      memoryStore: async ({ content }: { content: string }) => {
        if (content.trim().length === 0) {
          throw new EngramAccessInputError("content is required");
        }
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "global",
          dryRun: false,
          accepted: true,
          queued: false,
          status: "stored",
          memoryId: "fact-new",
        };
      },
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          content: "   ",
          category: "fact",
        }),
      });
      assert.equal(response.status, 400);
    }

    const valid = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "A durable explicit memory after invalid write attempts.",
        category: "fact",
      }),
    });
    assert.equal(valid.status, 201);
  } finally {
    await server.stop();
  }
});

test("access HTTP server does not consume the write rate limit for idempotency replays", async () => {
  const seenKeys = new Set<string>();
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      memoryStore: async ({ dryRun, idempotencyKey }: { dryRun?: boolean; idempotencyKey?: string }) => {
        const replay = Boolean(idempotencyKey && seenKeys.has(idempotencyKey));
        if (idempotencyKey) {
          seenKeys.add(idempotencyKey);
        }
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "global",
          dryRun: dryRun === true,
          accepted: true,
          queued: false,
          status: dryRun === true ? "validated" : "stored",
          memoryId: dryRun === true ? undefined : "fact-new",
          idempotencyKey,
          idempotencyReplay: replay,
        };
      },
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          idempotencyKey: "replay-key",
          content: "A durable explicit memory retried with the same idempotency key.",
          category: "fact",
        }),
      });
      assert.equal(response.status, 201);
    }

    const freshWrite = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        idempotencyKey: "fresh-key",
        content: "A fresh write should still fit inside the limiter budget after pure replays.",
        category: "fact",
      }),
    });
    assert.equal(freshWrite.status, 201);
  } finally {
    await server.stop();
  }
});

test("access HTTP server binds namespace write authorization to its configured principal", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
        {
          name: "secret-team",
          readPrincipals: ["secret-team"],
          writePrincipals: ["secret-team"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const headers = {
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
  };

  const rejectServer = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "project-x",
    maxBodyBytes: 1024,
  });
  const rejectStarted = await rejectServer.start();
  const rejectBase = `http://${rejectStarted.host}:${rejectStarted.port}`;

  try {
    const rejected = await fetch(`${rejectBase}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        dryRun: true,
        sessionKey: "agent:secret-team:chat",
        namespace: "secret-team",
        content: "Body sessionKey should not grant secret-team writes.",
        category: "fact",
      }),
    });
    assert.equal(rejected.status, 400);
    const payload = await rejected.json() as { error: string };
    assert.equal(payload.error, "namespace is not writable: secret-team");
  } finally {
    await rejectServer.stop();
  }

  const allowServer = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "secret-team",
    maxBodyBytes: 1024,
  });
  const allowStarted = await allowServer.start();
  const allowBase = `http://${allowStarted.host}:${allowStarted.port}`;

  try {
    const allowed = await fetch(`${allowBase}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        dryRun: true,
        sessionKey: "agent:project-x:chat",
        namespace: "secret-team",
        content: "Configured transport principal should authorize this dry run.",
        category: "fact",
      }),
    });
    assert.equal(allowed.status, 200);
    const payload = await allowed.json() as { status: string; namespace: string };
    assert.equal(payload.status, "validated");
    assert.equal(payload.namespace, "secret-team");
  } finally {
    await allowServer.stop();
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

test("access HTTP server returns 400 for explicit-capture validation errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-http-validation-"));
  const storage = new StorageManager(memoryDir);
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => storage,
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;
  const headers = {
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
  };

  try {
    const memoryResponse = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Validation should fail on invalid confidence.",
        category: "fact",
        confidence: 2,
      }),
    });
    assert.equal(memoryResponse.status, 400);
    const memoryPayload = await memoryResponse.json() as { error: string };
    assert.equal(memoryPayload.error, "confidence must be between 0 and 1");

    const suggestionResponse = await fetch(`${base}/engram/v1/suggestions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Suggestion validation should also fail on invalid confidence.",
        category: "fact",
        confidence: 2,
      }),
    });
    assert.equal(suggestionResponse.status, 400);
    const suggestionPayload = await suggestionResponse.json() as { error: string };
    assert.equal(suggestionPayload.error, "confidence must be between 0 and 1");
  } finally {
    await server.stop();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
