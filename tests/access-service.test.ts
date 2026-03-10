import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { EngramAccessInputError, EngramAccessService } from "../src/access-service.js";
import { runMemoryGovernance } from "../src/maintenance/memory-governance.ts";
import { rebuildMemoryProjection } from "../src/maintenance/rebuild-memory-projection.ts";
import { StorageManager } from "../src/storage.js";

function createService() {
  const orchestrator = {
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
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  return new EngramAccessService(orchestrator as any);
}

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function memoryDoc(id: string, content: string, extra: string[] = []): string {
  return [
    "---",
    `id: ${id}`,
    "category: fact",
    "created: 2026-03-01T00:00:00.000Z",
    "updated: 2026-03-08T00:00:00.000Z",
    "source: test",
    "confidence: 0.9",
    "confidenceTier: explicit",
    "tags: [\"ops\", \"admin\"]",
    ...extra,
    "---",
    "",
    content,
    "",
  ].join("\n");
}

test("access service rejects empty recall queries as input errors", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({ query: "   " }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "query is required",
  );
});

test("access service allows namespace-scoped recall when namespaces are enabled", async () => {
  const service = createService();
  const response = await service.recall({
    query: "hello",
    sessionKey: "agent:project-x:chat",
    namespace: "project-x",
  });
  assert.equal(response.namespace, "project-x");
});

test("access service rejects unreadable namespace-scoped recall overrides", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({
      query: "hello",
      sessionKey: "agent:project-x:chat",
      namespace: "global",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace override is not readable: global",
  );
});

test("access service recall forwards overrides and returns explainable metadata", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-08/fact-1.md");
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      memoryDoc("fact-1", "Operator-facing recall envelope coverage."),
    );
    const storage = new StorageManager(memoryDir);
    let capturedOptions: unknown;
    const snapshot = {
      sessionKey: "sess-1",
      recordedAt: "2026-03-08T00:00:00.000Z",
      queryHash: "hash",
      queryLen: 12,
      memoryIds: ["fact-1"],
      namespace: "global",
      traceId: "trace-1",
      plannerMode: "minimal",
      requestedMode: "minimal",
      fallbackUsed: true,
      sourcesUsed: ["cold_fallback", "memories"],
      budgetsApplied: {
        requestedTopK: 3,
        appliedTopK: 1,
        recallBudgetChars: 8000,
        maxMemoryTokens: 2000,
        qmdFetchLimit: 4,
        qmdHybridFetchLimit: 4,
      },
      latencyMs: 42,
      resultPaths: [memoryPath],
    };

    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: true,
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
      recall: async (_query: string, _sessionKey?: string, options?: unknown) => {
        capturedOptions = options;
        return "ctx";
      },
      lastRecall: { get: () => snapshot, getMostRecent: () => snapshot },
      getStorage: async () => storage,
      getLastIntentSnapshot: async () => ({
        recordedAt: "2026-03-08T00:00:00.000Z",
        promptHash: "prompt",
        promptLength: 5,
        retrievalQueryHash: "retrieval",
        retrievalQueryLength: 5,
        plannerEnabled: true,
        plannedMode: "minimal",
        effectiveMode: "minimal",
        recallResultLimit: 1,
        queryIntent: { tense: "present", goal: "recall", action: "recall", scope: "specific" },
        graphExpandedIntentDetected: false,
        graphDecision: {
          status: "not_requested",
          shadowMode: false,
          qmdAvailable: true,
          graphRecallEnabled: false,
          multiGraphMemoryEnabled: false,
        },
      }),
      getLastGraphRecallSnapshot: async () => null,
    } as any);

    const response = await service.recall({
      query: "hello",
      sessionKey: "sess-1",
      namespace: "global",
      topK: 3,
      mode: "minimal",
      includeDebug: true,
    });

    assert.deepEqual(capturedOptions, {
      namespace: "global",
      topK: 3,
      mode: "minimal",
    });
    assert.equal(response.namespace, "global");
    assert.equal(response.traceId, "trace-1");
    assert.equal(response.plannerMode, "minimal");
    assert.equal(response.fallbackUsed, true);
    assert.deepEqual(response.sourcesUsed, ["cold_fallback", "memories"]);
    assert.equal(response.results[0]?.id, "fact-1");
    assert.equal(response.budgetsApplied?.requestedTopK, 3);
    assert.equal(response.debug?.intent?.effectiveMode, "minimal");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service memoryStore persists and enforces idempotency conflicts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-store-"));
  try {
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

    const first = await service.memoryStore({
      schemaVersion: 1,
      idempotencyKey: "store-1",
      dryRun: false,
      content: "A durable explicit memory for access-layer coverage.",
      category: "fact",
      namespace: "global",
      sourceReason: "access regression coverage",
    });
    const second = await service.memoryStore({
      schemaVersion: 1,
      idempotencyKey: "store-1",
      dryRun: false,
      content: "A durable explicit memory for access-layer coverage.",
      category: "fact",
      namespace: "global",
      sourceReason: "access regression coverage",
    });

    assert.equal(first.status, "stored");
    assert.equal(second.memoryId, first.memoryId);
    assert.equal((await storage.readAllMemories()).length, 1);

    await assert.rejects(
      () => service.memoryStore({
        schemaVersion: 1,
        idempotencyKey: "store-1",
        dryRun: false,
        content: "A different explicit memory with the same idempotency key.",
        category: "fact",
        namespace: "global",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /idempotencyKey reuse conflict/.test(err.message),
    );

    const dryRun = await service.memoryStore({
      schemaVersion: 1,
      idempotencyKey: "store-dry-run",
      dryRun: true,
      content: "Validate this explicit capture before the real write happens.",
      category: "fact",
      namespace: "global",
    });
    const storedAfterDryRun = await service.memoryStore({
      schemaVersion: 1,
      idempotencyKey: "store-dry-run",
      dryRun: false,
      content: "Validate this explicit capture before the real write happens.",
      category: "fact",
      namespace: "global",
    });

    assert.equal(dryRun.status, "validated");
    assert.equal(storedAfterDryRun.status, "stored");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service suggestionSubmit queues pending review memories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-suggestion-"));
  try {
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

    const response = await service.suggestionSubmit({
      schemaVersion: 1,
      dryRun: false,
      content: "Suggestion content that should be queued for operator review.",
      category: "fact",
      namespace: "global",
    });
    const queued = response.memoryId ? await storage.getMemoryById(response.memoryId) : null;

    assert.equal(response.queued, true);
    assert.equal(response.status, "queued_for_review");
    assert.equal(queued?.frontmatter.status, "pending_review");

    await assert.rejects(
      () => service.suggestionSubmit({
        schemaVersion: 1,
        dryRun: false,
        content: "Rejected because the confidence is invalid.",
        category: "fact",
        confidence: 2,
        namespace: "global",
      }),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "confidence must be between 0 and 1",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service browses memories, lists entities, and applies review dispositions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      memoryDoc("fact-1", "Admin console memory browser target.", ['entityRef: person-alex', 'status: pending_review']),
    );
    await writeText(
      memoryDir,
      "entities/person-alex.md",
      [
        "# Alex",
        "",
        "type: person",
        "updated: 2026-03-08T00:00:00.000Z",
        "",
        "## Summary",
        "",
        "Owns operations tooling.",
        "",
        "## Aliases",
        "",
        "- Alex Ops",
        "",
        "## Facts",
        "",
        "- Maintains Engram.",
        "",
      ].join("\n"),
    );

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({ query: "browser" });
    assert.equal(browse.total, 1);
    assert.equal(browse.memories[0]?.id, "fact-1");

    const entities = await service.entityList({ query: "alex" });
    assert.equal(entities.total, 1);
    assert.equal(entities.entities[0]?.name, "Alex");

    const entity = await service.entityGet("person-alex");
    assert.equal(entity.found, true);
    assert.equal(entity.entity?.aliases.includes("Alex Ops"), true);

    const disposition = await service.reviewDisposition({
      memoryId: "fact-1",
      status: "active",
      reasonCode: "operator_confirmed",
    });
    assert.equal(disposition.ok, true);
    assert.equal(disposition.previousStatus, "pending_review");

    const updated = await storage.getMemoryById("fact-1");
    assert.equal(updated?.frontmatter.status, "active");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service uses projection-backed browse filters, including archived memories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-projection-browse-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-active.md",
      memoryDoc("fact-active", "Active memory that should be filtered out.", ['entityRef: person-active']),
    );
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      memoryDoc(
        "fact-archived",
        "Retired browser coverage memory for the archived projection path.",
        ['entityRef: person-retired', 'archivedAt: 2026-03-08T02:00:00.000Z', 'tags: ["legacy", "browser"]'],
      ),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({
      query: "retired",
      status: "archived",
      category: "fact",
    });
    assert.equal(browse.total, 1);
    assert.equal(browse.count, 1);
    assert.equal(browse.memories[0]?.id, "fact-archived");
    assert.equal(browse.memories[0]?.status, "archived");
    assert.equal(browse.memories[0]?.entityRef, "person-retired");
    assert.deepEqual([...((browse.memories[0]?.tags ?? []).slice())].sort(), ["browser", "legacy"]);
    assert.match(browse.memories[0]?.path ?? "", /archive\/2026-03-08\/fact-archived\.md$/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service fallback browse infers archived status from archive paths without a projection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-fallback-archived-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      memoryDoc(
        "fact-archived",
        "Archived memory that should still appear without projection browse.",
        ['entityRef: person-retired', 'tags: ["legacy", "browser", "legacy"]'],
      ),
    );

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({
      query: "archived memory",
      status: "archived",
      category: "fact",
    });
    assert.equal(browse.total, 1);
    assert.equal(browse.memories[0]?.id, "fact-archived");
    assert.equal(browse.memories[0]?.status, "archived");
    assert.deepEqual(browse.memories[0]?.tags, ["browser", "legacy"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service projection browse matches full content beyond preview text", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-projection-content-"));
  try {
    const deepNeedle = "full content projection query";
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-deep.md",
      memoryDoc(
        "fact-deep",
        `${"alpha ".repeat(60)}${deepNeedle}`,
        ['entityRef: person-deep', 'tags: ["projection", "content"]'],
      ),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({
      query: deepNeedle,
      status: "active",
      category: "fact",
    });
    assert.equal(browse.total, 1);
    assert.equal(browse.count, 1);
    assert.equal(browse.memories[0]?.id, "fact-deep");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service reviewQueue and maintenance fall back to governance artifacts when projection is absent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-fallback-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc("fact-duplicate-a", "Exact duplicate for governance fallback coverage.", ['confidence: 0.95']),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc("fact-duplicate-b", "Exact duplicate for governance fallback coverage.", ['confidence: 0.45']),
    );

    const governance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const queue = await service.reviewQueue();
    assert.equal(queue.found, true);
    assert.equal(queue.runId, governance.runId);
    assert.equal(queue.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"), true);

    const maintenance = await service.maintenance();
    assert.equal(maintenance.health.projectionAvailable, false);
    assert.equal(maintenance.latestGovernanceRun.found, true);
    assert.equal(maintenance.latestGovernanceRun.runId, governance.runId);
    assert.equal(
      maintenance.latestGovernanceRun.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"),
      true,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service serves reviewQueue and maintenance from projection when governance artifacts are gone", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-projection-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc("fact-duplicate-a", "Exact duplicate for projection review queue coverage.", ['confidence: 0.95']),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc("fact-duplicate-b", "Exact duplicate for projection review queue coverage.", ['confidence: 0.45']),
    );

    const governance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-09T12:05:00.000Z"),
    });
    await rm(path.join(memoryDir, "state", "memory-governance"), { recursive: true, force: true });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const queue = await service.reviewQueue(governance.runId);
    assert.equal(queue.found, true);
    assert.equal(queue.runId, governance.runId);
    assert.equal(queue.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"), true);
    assert.equal("runId" in (queue.reviewQueue?.[0] ?? {}), false);

    const maintenance = await service.maintenance();
    assert.equal(maintenance.health.projectionAvailable, true);
    assert.equal(maintenance.latestGovernanceRun.found, true);
    assert.equal(maintenance.latestGovernanceRun.runId, governance.runId);
    assert.equal(
      maintenance.latestGovernanceRun.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"),
      true,
    );
    assert.equal("runId" in (maintenance.latestGovernanceRun.reviewQueue?.[0] ?? {}), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
