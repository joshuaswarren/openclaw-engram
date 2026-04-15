import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { EngramAccessInputError, EngramAccessService } from "../src/access-service.js";
import { runMemoryGovernance } from "../src/maintenance/memory-governance.ts";
import { rebuildMemoryProjection } from "../src/maintenance/rebuild-memory-projection.ts";
import { getMemoryProjectionPath } from "../src/memory-projection-store.js";
import { StorageManager } from "../src/storage.js";
import { recordTrustZoneRecord } from "../src/trust-zones.ts";

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

test("access service allows readable namespace overrides outside default recall namespaces", async () => {
  let capturedOptions: unknown;
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
          name: "project-y",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-y"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async (_query: string, _sessionKey?: string, options?: unknown) => {
      capturedOptions = options;
      return "ctx";
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  } as any);

  const response = await service.recall({
    query: "hello",
    sessionKey: "agent:project-x:chat",
    namespace: "project-y",
  });

  assert.equal(response.namespace, "project-y");
  assert.deepEqual(capturedOptions, {
    namespace: "project-y",
    topK: undefined,
    mode: undefined,
  });
});

test("access service rejects unreadable namespace-scoped recall overrides", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({
      query: "hello",
      sessionKey: "agent:project-x:chat",
      namespace: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace override is not readable: secret-team",
  );
});

test("access service allows readable explicit namespace overrides outside default recall routing", async () => {
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
          name: "audit-log",
          readPrincipals: ["project-x"],
          writePrincipals: ["audit-bot"],
          includeInRecallByDefault: false,
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
  } as any);

  const response = await service.recall({
    query: "hello",
    sessionKey: "agent:project-x:chat",
    namespace: "audit-log",
  });

  assert.equal(response.namespace, "audit-log");
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
        namespacePolicies: [{
          name: "project-x",
          readPrincipals: ["*"],
          writePrincipals: ["*"],
        }],
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

test("access service recall reports the effective snapshot namespace in response and debug lookups", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-effective-ns-"));
  try {
    const storage = new StorageManager(memoryDir);
    let intentNamespace = "";
    let graphNamespace = "";
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: true,
        defaultNamespace: "global",
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [{
          name: "project-x",
          readPrincipals: ["*"],
          writePrincipals: ["*"],
        }],
        defaultRecallNamespaces: ["self"],
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: {
        get: () => ({
          sessionKey: "user:alpha:job",
          namespace: "team-alpha",
          memoryIds: [],
          resultPaths: [],
          plannerMode: "minimal",
          fallbackUsed: false,
          sourcesUsed: ["memories"],
          recordedAt: "2026-03-10T00:00:00.000Z",
          traceId: "trace-effective-ns",
          budgetsApplied: undefined,
          latencyMs: 12,
        }),
        getMostRecent: () => null,
      },
      getStorage: async () => storage,
      getLastIntentSnapshot: async (namespace: string) => {
        intentNamespace = namespace;
        return null;
      },
      getLastGraphRecallSnapshot: async (namespace: string) => {
        graphNamespace = namespace;
        return null;
      },
    } as any);

    const response = await service.recall({
      query: "What is in my namespace?",
      sessionKey: "user:alpha:job",
      includeDebug: true,
    });

    assert.equal(response.namespace, "team-alpha");
    assert.equal(intentNamespace, "team-alpha");
    assert.equal(graphNamespace, "team-alpha");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service serializes result paths from the snapshot namespace", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-path-namespace-"));
  try {
    const globalStorage = new StorageManager(memoryDir);
    const namespaceStorage = new StorageManager(path.join(memoryDir, "namespaces", "project-x"));
    const namespacedPath = path.join(namespaceStorage.dir, "archive/2026-03-08/fact-project.md");
    await writeText(
      namespaceStorage.dir,
      "archive/2026-03-08/fact-project.md",
      memoryDoc(
        "fact-project",
        "Namespace-scoped path recall serialization.",
        ['archivedAt: 2026-03-08T01:00:00.000Z'],
      ),
    );
    const snapshot = {
      sessionKey: "sess-1",
      recordedAt: "2026-03-08T00:00:00.000Z",
      queryHash: "hash",
      queryLen: 12,
      memoryIds: [],
      namespace: "project-x",
      traceId: "trace-1",
      plannerMode: "full",
      requestedMode: "full",
      fallbackUsed: false,
      sourcesUsed: ["hot_qmd"],
      budgetsApplied: {
        appliedTopK: 1,
        recallBudgetChars: 8000,
        maxMemoryTokens: 2000,
      },
      latencyMs: 12,
      resultPaths: [namespacedPath],
    };

    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: true,
        defaultNamespace: "global",
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [{
          name: "project-x",
          readPrincipals: ["*"],
          writePrincipals: ["*"],
        }],
        defaultRecallNamespaces: ["self"],
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => snapshot, getMostRecent: () => snapshot },
      getStorage: async (namespace?: string) => (namespace === "project-x" ? namespaceStorage : globalStorage),
      getLastIntentSnapshot: async () => null,
      getLastGraphRecallSnapshot: async () => null,
    } as any);

    const response = await service.recall({
      query: "namespace path recall",
      sessionKey: "sess-1",
      namespace: "project-x",
    });

    assert.equal(response.namespace, "project-x");
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.id, "fact-project");
    assert.equal(response.results[0]?.status, "archived");
    assert.match(response.results[0]?.path ?? "", /archive\/2026-03-08\/fact-project\.md$/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service recall count stays aligned with snapshot memory ids when some memories cannot be serialized", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-count-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-08/fact-present.md");
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-present.md",
      memoryDoc("fact-present", "Only one memory is still readable."),
    );
    const storage = new StorageManager(memoryDir);
    const snapshot = {
      sessionKey: "sess-count",
      recordedAt: "2026-03-10T00:00:00.000Z",
      queryHash: "hash",
      queryLen: 8,
      memoryIds: ["fact-present", "fact-missing"],
      namespace: "global",
      traceId: "trace-count",
      plannerMode: "minimal",
      requestedMode: "minimal",
      fallbackUsed: false,
      sourcesUsed: ["memories"],
      budgetsApplied: undefined,
      latencyMs: 9,
      resultPaths: [memoryPath, path.join(memoryDir, "facts/2026-03-08/fact-missing.md")],
    };

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
      lastRecall: { get: () => snapshot, getMostRecent: () => snapshot },
      getStorage: async () => storage,
      getLastIntentSnapshot: async () => null,
      getLastGraphRecallSnapshot: async () => null,
    } as any);

    const response = await service.recall({
      query: "missing?",
      sessionKey: "sess-count",
    });

    assert.equal(response.count, 2);
    assert.deepEqual(response.memoryIds, ["fact-present", "fact-missing"]);
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.id, "fact-present");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service recall without a session key does not reuse another session snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-recall-no-session-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-08/fact-stale.md");
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-stale.md",
      memoryDoc("fact-stale", "This memory belongs to a different session."),
    );
    const storage = new StorageManager(memoryDir);
    let getMostRecentCalls = 0;
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx-without-session",
      lastRecall: {
        get: () => null,
        getMostRecent: () => {
          getMostRecentCalls += 1;
          return {
            sessionKey: "other-session",
            recordedAt: "2026-03-10T00:00:00.000Z",
            queryHash: "hash",
            queryLen: 8,
            memoryIds: ["fact-stale"],
            namespace: "other-namespace",
            traceId: "trace-stale",
            plannerMode: "minimal",
            requestedMode: "minimal",
            fallbackUsed: false,
            sourcesUsed: ["memories"],
            budgetsApplied: undefined,
            latencyMs: 4,
            resultPaths: [memoryPath],
          };
        },
      },
      getStorage: async () => storage,
      getLastIntentSnapshot: async () => ({
        recordedAt: "2026-03-10T00:00:00.000Z",
        promptHash: "prompt",
        promptLength: 12,
        retrievalQueryHash: "query",
        retrievalQueryLength: 12,
        plannerEnabled: true,
        plannedMode: "minimal",
        reasoning: "debug state from another session",
      }),
      getLastGraphRecallSnapshot: async () => ({
        recordedAt: "2026-03-10T00:00:00.000Z",
        queryHash: "graph",
        graphMode: "off",
        nodes: [],
        edges: [],
      }),
    } as any);

    const response = await service.recall({
      query: "fresh request",
      includeDebug: true,
    });

    assert.equal(getMostRecentCalls, 0);
    assert.equal(response.sessionKey, undefined);
    assert.equal(response.namespace, "global");
    assert.equal(response.context, "ctx-without-session");
    assert.equal(response.count, 0);
    assert.deepEqual(response.memoryIds, []);
    assert.deepEqual(response.results, []);
    assert.equal(response.recordedAt, undefined);
    assert.equal(response.traceId, undefined);
    assert.equal(response.debug, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service recallExplain omits mismatched most-recent snapshot when namespace is requested", async () => {
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
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => ({
        sessionKey: "other-session",
        namespace: "global",
        memoryIds: ["fact-1"],
        resultPaths: [],
      }),
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const response = await service.recallExplain({
    namespace: "shared",
  });

  assert.equal(response.snapshot, undefined);
  assert.equal(response.found, false);
});

test("access service recallExplain omits most-recent snapshots without a namespace when a namespace is requested", async () => {
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
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => ({
        sessionKey: "other-session",
        memoryIds: ["fact-1"],
        resultPaths: [],
      }),
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const response = await service.recallExplain({
    namespace: "project-x",
  });

  assert.equal(response.snapshot, undefined);
  assert.equal(response.found, false);
});

test("access service recallExplain without a namespace preserves the most recent non-default snapshot", async () => {
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
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => ({
        sessionKey: "other-session",
        namespace: "shared",
        memoryIds: ["fact-1"],
        resultPaths: [],
      }),
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const response = await service.recallExplain();

  assert.equal(response.found, true);
  assert.equal(response.snapshot?.namespace, "shared");
});

test("access service recallExplain filters session snapshots by the requested namespace", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [
        {
          match: "project-x:",
          principal: "project-x",
        },
      ],
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
      get: () => ({
        sessionKey: "project-x:session",
        namespace: "global",
        memoryIds: ["fact-1"],
        resultPaths: [],
      }),
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const response = await service.recallExplain({
    sessionKey: "project-x:session",
    namespace: "project-x",
  });

  assert.equal(response.found, false);
  assert.equal(response.snapshot, undefined);
});

test("access service memoryStore persists and enforces idempotency conflicts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-store-"));
  try {
    const storage = new StorageManager(memoryDir);
    const originalWriteMemory = storage.writeMemory.bind(storage);
    let writeCalls = 0;
    storage.writeMemory = (async (...args: Parameters<typeof originalWriteMemory>) => {
      writeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalWriteMemory(...args);
    }) as typeof storage.writeMemory;
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
    assert.equal(first.idempotencyReplay, undefined);
    assert.equal(second.memoryId, first.memoryId);
    assert.equal(second.idempotencyReplay, true);
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

    const [concurrentA, concurrentB] = await Promise.all([
      service.memoryStore({
        schemaVersion: 1,
        idempotencyKey: "store-concurrent",
        dryRun: false,
        content: "A concurrent explicit memory that should only persist once.",
        category: "fact",
        namespace: "global",
      }),
      service.memoryStore({
        schemaVersion: 1,
        idempotencyKey: "store-concurrent",
        dryRun: false,
        content: "A concurrent explicit memory that should only persist once.",
        category: "fact",
        namespace: "global",
      }),
    ]);

    assert.equal(concurrentA.memoryId, concurrentB.memoryId);
    assert.equal(writeCalls, 3);
    assert.equal((await storage.readAllMemories()).length, 3);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service acquires a shared idempotency key lock before executing writes across service instances", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-shared-idempotency-"));
  try {
    const config = {
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
    };
    const orchestrator = {
      config,
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => ({
        getMemoryById: async () => null,
        getMemoryTimeline: async () => [],
      }),
      getLastIntentSnapshot: async () => null,
      getLastGraphRecallSnapshot: async () => null,
    };
    const serviceA = new EngramAccessService(orchestrator as any);
    const serviceB = new EngramAccessService(orchestrator as any);
    let releaseFirstExecute: (() => void) | null = null;
    const firstExecutePaused = new Promise<void>((resolve) => {
      releaseFirstExecute = resolve;
    });
    let firstExecuteEnteredResolve: (() => void) | null = null;
    const firstExecuteEntered = new Promise<void>((resolve) => {
      firstExecuteEnteredResolve = resolve;
    });
    let executeCalls = 0;

    const first = (serviceA as any).handleIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: "shared-write",
      requestFingerprint: { content: "same write" },
      execute: async () => {
        executeCalls += 1;
        firstExecuteEnteredResolve?.();
        await firstExecutePaused;
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "global",
          dryRun: false,
          accepted: true,
          queued: false,
          status: "stored",
          memoryId: "fact-shared",
          idempotencyKey: "shared-write",
        };
      },
    });
    await firstExecuteEntered;

    let secondExecuteStarted = false;
    const second = (serviceB as any).handleIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: "shared-write",
      requestFingerprint: { content: "same write" },
      execute: async () => {
        secondExecuteStarted = true;
        executeCalls += 1;
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "global",
          dryRun: false,
          accepted: true,
          queued: false,
          status: "stored",
          memoryId: "fact-shared",
          idempotencyKey: "shared-write",
        };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondExecuteStarted, false);

    releaseFirstExecute?.();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    assert.equal(executeCalls, 1);
    assert.deepEqual(firstResponse, {
      schemaVersion: 1,
      operation: "memory_store",
      namespace: "global",
      dryRun: false,
      accepted: true,
      queued: false,
      status: "stored",
      memoryId: "fact-shared",
      idempotencyKey: "shared-write",
    });
    assert.deepEqual(secondResponse, {
      ...firstResponse,
      idempotencyReplay: true,
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service write operations reject namespaces the caller cannot write", async () => {
  const service = createService();

  await assert.rejects(
    () => service.memoryStore({
      schemaVersion: 1,
      dryRun: false,
      sessionKey: "agent:project-x:chat",
      content: "Attempt to write into another team's namespace.",
      category: "fact",
      namespace: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace is not writable: secret-team",
  );

  await assert.rejects(
    () => service.suggestionSubmit({
      schemaVersion: 1,
      dryRun: false,
      sessionKey: "agent:project-x:chat",
      content: "Attempt to queue another team's namespace for review.",
      category: "fact",
      namespace: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace is not writable: secret-team",
  );
});

test("access service write authorization uses the trusted transport principal instead of client sessionKey", async () => {
  const service = createService();

  await assert.rejects(
    () => service.memoryStore({
      schemaVersion: 1,
      dryRun: true,
      sessionKey: "agent:secret-team:chat",
      authenticatedPrincipal: "project-x",
      content: "Spoofed sessionKey should not unlock another namespace.",
      category: "fact",
      namespace: "secret-team",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace is not writable: secret-team",
  );

  const validated = await service.suggestionSubmit({
    schemaVersion: 1,
    dryRun: true,
    sessionKey: "agent:project-x:chat",
    authenticatedPrincipal: "secret-team",
    content: "Trusted transport principal should authorize the namespace.",
    category: "fact",
    namespace: "secret-team",
  });

  assert.equal(validated.status, "validated");
  assert.equal(validated.namespace, "secret-team");
});

test("access service review dispositions reject namespaces outside the trusted transport principal", async () => {
  const service = createService();

  await assert.rejects(
    () => service.reviewDisposition({
      memoryId: "fact-1",
      status: "active",
      reasonCode: "operator_confirmed",
      namespace: "secret-team",
      authenticatedPrincipal: "project-x",
    }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "namespace is not writable: secret-team",
  );
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
        err instanceof EngramAccessInputError &&
        err.message === "confidence must be between 0 and 1",
    );

    const sanitized = await service.suggestionSubmit({
      schemaVersion: 1,
      dryRun: false,
      content: "  Suggestion content that should be normalized before review.  ",
      category: "fact",
      namespace: "global",
      tags: [" review ", "queue", "review"],
      sourceReason: "  submitted via suggestion submit  ",
    });
    const sanitizedQueued = sanitized.memoryId ? await storage.getMemoryById(sanitized.memoryId) : null;

    assert.equal(sanitizedQueued?.frontmatter.status, "pending_review");
    assert.match(sanitizedQueued?.content ?? "", /Submitted content:\nSuggestion content that should be normalized before review\./);
    assert.match(sanitizedQueued?.content ?? "", /Requested sourceReason: submitted via suggestion submit/);
    assert.match(sanitizedQueued?.content ?? "", /Requested tags: review, queue/);
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
        "## Beliefs",
        "",
        "- Small teams should own whole systems.",
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

    const structuredEntities = await service.entityList({ query: "whole systems" });
    assert.equal(structuredEntities.total, 1);
    assert.equal(structuredEntities.entities[0]?.name, "Alex");

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

test("access service supports explicit browse sorting for projection-backed and fallback memory pages", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-browse-sort-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-02-01/fact-older.md",
      memoryDoc("fact-older", "Older memory for browse sorting.", ['created: 2026-02-01T00:00:00.000Z', 'updated: 2026-02-02T00:00:00.000Z']),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-newer.md",
      memoryDoc("fact-newer", "Newer memory for browse sorting.", ['created: 2026-03-01T00:00:00.000Z', 'updated: 2026-03-05T00:00:00.000Z']),
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

    const projectedPage = await service.memoryBrowse({
      sort: "created_asc",
      limit: 10,
      offset: 0,
    });
    assert.equal(projectedPage.sort, "created_asc");
    assert.deepEqual(projectedPage.memories.map((memory) => memory.id), ["fact-older", "fact-newer"]);

    const fallbackPage = await service.memoryBrowse({
      query: "browse sorting",
      sort: "created_desc",
      limit: 10,
      offset: 0,
    });
    assert.equal(fallbackPage.sort, "created_desc");
    assert.deepEqual(fallbackPage.memories.map((memory) => memory.id), ["fact-newer", "fact-older"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service fallback browse matches projection secondary timestamp tie breakers", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-browse-tiebreak-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-earlier-created.md",
      memoryDoc(
        "fact-earlier-created",
        "Equal updated timestamps should still sort by created timestamp.",
        ['created: 2026-03-01T00:00:00.000Z', 'updated: 2026-03-08T12:00:00.000Z'],
      ),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-05/fact-later-created.md",
      memoryDoc(
        "fact-later-created",
        "Equal updated timestamps should still sort by created timestamp.",
        ['created: 2026-03-05T00:00:00.000Z', 'updated: 2026-03-08T12:00:00.000Z'],
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

    const projectedPage = await service.memoryBrowse({
      sort: "updated_desc",
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(projectedPage.memories.map((memory) => memory.id), [
      "fact-later-created",
      "fact-earlier-created",
    ]);

    await rm(getMemoryProjectionPath(memoryDir), { force: true });

    const fallbackPage = await service.memoryBrowse({
      sort: "updated_desc",
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(fallbackPage.memories.map((memory) => memory.id), [
      "fact-later-created",
      "fact-earlier-created",
    ]);
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

    const queue = await service.reviewQueue(undefined, "global");
    assert.equal(queue.found, true);
    assert.equal(queue.namespace, "global");
    assert.equal(queue.runId, governance.runId);
    assert.equal(queue.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"), true);
    assert.equal((queue.qualityScore?.score ?? 0) < 100, true);
    assert.equal(Object.keys(queue.transitionReport?.proposed ?? {}).length > 0, true);

    const maintenance = await service.maintenance("global");
    assert.equal(maintenance.health.projectionAvailable, false);
    assert.equal(maintenance.namespace, "global");
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
    assert.equal(queue.namespace, "global");
    assert.equal(queue.runId, governance.runId);
    assert.equal(queue.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"), true);
    assert.equal("runId" in (queue.reviewQueue?.[0] ?? {}), false);
    assert.equal((queue.qualityScore?.score ?? 0) < 100, true);
    assert.ok(queue.transitionReport);
    assert.equal(Object.keys(queue.transitionReport?.proposed ?? {}).length > 0, true);
    assert.equal(Object.keys(queue.transitionReport?.applied ?? {}).length, 0);

    const maintenance = await service.maintenance("global");
    assert.equal(maintenance.health.projectionAvailable, true);
    assert.equal(maintenance.namespace, "global");
    assert.equal(maintenance.latestGovernanceRun.found, true);
    assert.equal(maintenance.latestGovernanceRun.runId, governance.runId);
    assert.equal(
      maintenance.latestGovernanceRun.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"),
      true,
    );
    assert.equal("runId" in (maintenance.latestGovernanceRun.reviewQueue?.[0] ?? {}), false);
    assert.ok(maintenance.latestGovernanceRun.transitionReport);
    assert.equal(Object.keys(maintenance.latestGovernanceRun.transitionReport?.proposed ?? {}).length > 0, true);
    assert.equal(Object.keys(maintenance.latestGovernanceRun.transitionReport?.applied ?? {}).length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service builds a quality dashboard summary from memory state and governance artifacts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-quality-"));
  try {
    await writeText(
      memoryDir,
      "facts/2025-11-01/fact-stale-low.md",
      memoryDoc(
        "fact-stale-low",
        "Potential archive candidate with stale low-confidence memory content.",
        [
          'created: 2025-11-01T00:00:00.000Z',
          'updated: 2025-11-02T00:00:00.000Z',
          'confidence: 0.45',
          'confidenceTier: tentative',
          'status: PENDING_REVIEW',
        ],
      ),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-fresh.md",
      memoryDoc(
        "fact-fresh",
        "Fresh active memory for quality dashboard coverage.",
        [
          'created: 2026-03-08T00:00:00.000Z',
          'updated: 2026-03-08T00:00:00.000Z',
          'confidence: 0.92',
          'confidenceTier: explicit',
        ],
      ),
    );
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      memoryDoc(
        "fact-archived",
        "Archived memory for quality dashboard coverage.",
        [
          'created: 2026-02-15T00:00:00.000Z',
          'updated: 2026-02-16T00:00:00.000Z',
          'archivedAt: 2026-03-08T00:00:00.000Z',
          'confidence: 0.7',
          'confidenceTier: implied',
        ],
      ),
    );

    await runMemoryGovernance({
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

    const quality = await service.quality();
    assert.equal(quality.totalMemories, 3);
    assert.equal(quality.statusCounts.pending_review, 1);
    assert.equal(quality.statusCounts.active, 1);
    assert.equal(quality.statusCounts.archived, 1);
    assert.equal(quality.confidenceTierCounts.tentative, 1);
    assert.equal(quality.archivePressure.pendingReview, 1);
    assert.equal(quality.archivePressure.archived, 1);
    assert.equal(quality.archivePressure.lowConfidenceActive, 0);
    assert.equal(quality.latestGovernanceRun.found, true);
    assert.equal(typeof quality.latestGovernanceRun.qualityScore?.score, "number");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service backfills projected governance quality scores from projected metrics when artifacts are gone", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-quality-"));
  try {
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
      getStorage: async () =>
        ({
          dir: memoryDir,
          async getProjectedGovernanceRecord() {
            return {
              runId: "gov-legacy",
              summary: {
                runId: "gov-legacy",
                traceId: "trace-legacy",
                mode: "shadow",
                createdAt: "2026-03-09T12:00:00.000Z",
                scannedMemories: 2,
                reviewQueueCount: 1,
                proposedActionCount: 1,
                appliedActionCount: 0,
                ruleVersion: "memory-governance.v2",
                schemaVersion: 1,
              },
              metrics: {
                reviewReasons: {
                  exact_duplicate: 1,
                  semantic_duplicate_candidate: 0,
                  disputed_memory: 0,
                  speculative_low_confidence: 0,
                  archive_candidate: 0,
                  explicit_capture_review: 0,
                  malformed_import: 0,
                },
                proposedStatuses: {
                  pending_review: 1,
                },
                keptMemoryCount: 1,
              },
              reviewQueueRows: [{
                runId: "gov-legacy",
                entryId: "review:fact-1:exact_duplicate",
                memoryId: "fact-1",
                path: path.join(memoryDir, "facts/2026-03-01/fact-1.md"),
                reasonCode: "exact_duplicate",
                severity: "medium",
                suggestedAction: "set_status",
                suggestedStatus: "pending_review",
                relatedMemoryIds: ["fact-2"],
              }],
              appliedActionRows: [],
              report: "legacy projected report",
            };
          },
          async getMemoryById(memoryId: string) {
            if (memoryId !== "fact-1") return null;
            return {
              path: path.join(memoryDir, "facts/2026-03-01/fact-1.md"),
              frontmatter: {
                id: "fact-1",
                category: "fact",
                created: "2026-03-01T00:00:00.000Z",
                updated: "2026-03-01T00:00:00.000Z",
                source: "test",
                confidence: 0.9,
                confidenceTier: "explicit",
                tags: [],
              },
              content: "Exact duplicate for projected quality-score fallback coverage.",
            };
          },
        }) as any,
    } as any);

    const queue = await service.reviewQueue("gov-legacy");
    assert.equal(queue.found, true);
    assert.equal(queue.qualityScore?.score, 94);
    assert.equal(queue.qualityScore?.grade, "excellent");
    assert.equal(queue.metrics?.qualityScore?.score, 94);
    assert.equal(queue.metrics?.qualityScore?.grade, "excellent");
    assert.equal(Object.keys(queue.transitionReport?.proposed ?? {}).length > 0, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service projected governance fallback mirrors same-status filtering and per-memory action priority", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-proposed-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-01/fact-1.md");
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
      getStorage: async () =>
        ({
          dir: memoryDir,
          async getProjectedGovernanceRecord() {
            return {
              runId: "gov-proposed",
              summary: {
                runId: "gov-proposed",
                traceId: "trace-proposed",
                mode: "shadow",
                createdAt: "2026-03-09T12:00:00.000Z",
                scannedMemories: 1,
                reviewQueueCount: 2,
                proposedActionCount: 1,
                appliedActionCount: 0,
                ruleVersion: "memory-governance.v2",
                schemaVersion: 1,
              },
              metrics: {
                reviewReasons: {
                  exact_duplicate: 0,
                  semantic_duplicate_candidate: 0,
                  disputed_memory: 0,
                  speculative_low_confidence: 0,
                  archive_candidate: 1,
                  explicit_capture_review: 1,
                  malformed_import: 0,
                },
                proposedStatuses: {
                  archived: 1,
                },
                keptMemoryCount: 0,
              },
              reviewQueueRows: [
                {
                  runId: "gov-proposed",
                  entryId: "review:fact-1:explicit_capture_review",
                  memoryId: "fact-1",
                  path: memoryPath,
                  reasonCode: "explicit_capture_review",
                  severity: "low",
                  suggestedAction: "set_status",
                  suggestedStatus: "pending_review",
                  relatedMemoryIds: [],
                },
                {
                  runId: "gov-proposed",
                  entryId: "review:fact-1:archive_candidate",
                  memoryId: "fact-1",
                  path: memoryPath,
                  reasonCode: "archive_candidate",
                  severity: "medium",
                  suggestedAction: "archive",
                  suggestedStatus: undefined,
                  relatedMemoryIds: [],
                },
              ],
              appliedActionRows: [],
              report: "projected proposed report",
            };
          },
          async getMemoryById(memoryId: string) {
            if (memoryId !== "fact-1") return null;
            return {
              path: memoryPath,
              frontmatter: {
                id: "fact-1",
                category: "fact",
                created: "2026-03-01T00:00:00.000Z",
                updated: "2026-03-01T00:00:00.000Z",
                source: "test",
                confidence: 0.9,
                confidenceTier: "explicit",
                status: "pending_review",
                tags: [],
              },
              content: "Projected review queue dedupe coverage.",
            };
          },
        }) as any,
    } as any);

    const queue = await service.reviewQueue("gov-proposed");
    assert.equal(queue.found, true);
    assert.deepEqual(Object.keys(queue.transitionReport?.proposed ?? {}), ["archived"]);
    assert.equal(queue.transitionReport?.proposed.archived?.length, 1);
    assert.equal(queue.transitionReport?.proposed.archived?.[0]?.reasonCode, "archive_candidate");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service projected governance response reconstructs proposed transitions when legacy artifacts leave them empty", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-legacy-transitions-"));
  try {
    const memoryPath = path.join(memoryDir, "facts/2026-03-01/fact-1.md");
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/summary.json",
      JSON.stringify({
        runId: "gov-legacy-artifact",
        traceId: "trace-legacy-artifact",
        mode: "shadow",
        createdAt: "2026-03-09T12:00:00.000Z",
        scannedMemories: 1,
        reviewQueueCount: 1,
        proposedActionCount: 1,
        appliedActionCount: 0,
        ruleVersion: "memory-governance.v2",
        schemaVersion: 1,
      }),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/metrics.json",
      JSON.stringify({
        reviewReasons: {
          exact_duplicate: 0,
          semantic_duplicate_candidate: 0,
          disputed_memory: 0,
          speculative_low_confidence: 0,
          archive_candidate: 1,
          explicit_capture_review: 0,
          malformed_import: 0,
        },
        proposedStatuses: {
          archived: 1,
        },
        keptMemoryCount: 0,
      }),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/kept-memories.json",
      JSON.stringify([]),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/review-queue.json",
      JSON.stringify([]),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/applied-actions.json",
      JSON.stringify([]),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/status-transitions.json",
      JSON.stringify({
        proposed: {},
        applied: {},
      }),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        runId: "gov-legacy-artifact",
        traceId: "trace-legacy-artifact",
        mode: "shadow",
        createdAt: "2026-03-09T12:00:00.000Z",
        ruleVersion: "memory-governance.v2",
        artifacts: {},
      }),
    );
    await writeText(
      memoryDir,
      "state/memory-governance/runs/gov-legacy-artifact/report.md",
      "legacy artifact report\n",
    );

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
      getStorage: async () =>
        ({
          dir: memoryDir,
          async getProjectedGovernanceRecord() {
            return {
              runId: "gov-legacy-artifact",
              summary: {
                runId: "gov-legacy-artifact",
                traceId: "trace-legacy-artifact",
                mode: "shadow",
                createdAt: "2026-03-09T12:00:00.000Z",
                scannedMemories: 1,
                reviewQueueCount: 1,
                proposedActionCount: 1,
                appliedActionCount: 0,
                ruleVersion: "memory-governance.v2",
                schemaVersion: 1,
              },
              metrics: {
                reviewReasons: {
                  exact_duplicate: 0,
                  semantic_duplicate_candidate: 0,
                  disputed_memory: 0,
                  speculative_low_confidence: 0,
                  archive_candidate: 1,
                  explicit_capture_review: 0,
                  malformed_import: 0,
                },
                proposedStatuses: {
                  archived: 1,
                },
                keptMemoryCount: 0,
              },
              reviewQueueRows: [{
                runId: "gov-legacy-artifact",
                entryId: "review:fact-1:archive_candidate",
                memoryId: "fact-1",
                path: memoryPath,
                reasonCode: "archive_candidate",
                severity: "medium",
                suggestedAction: "archive",
                suggestedStatus: undefined,
                relatedMemoryIds: [],
              }],
              appliedActionRows: [],
              report: "legacy artifact report",
            };
          },
          async getMemoryById(memoryId: string) {
            if (memoryId !== "fact-1") return null;
            return {
              path: memoryPath,
              frontmatter: {
                id: "fact-1",
                category: "fact",
                created: "2026-03-01T00:00:00.000Z",
                updated: "2026-03-01T00:00:00.000Z",
                source: "test",
                confidence: 0.9,
                confidenceTier: "explicit",
                status: "active",
                tags: [],
              },
              content: "Legacy artifact projected transition fallback coverage.",
            };
          },
        }) as any,
    } as any);

    const queue = await service.reviewQueue("gov-legacy-artifact");
    assert.equal(queue.found, true);
    assert.deepEqual(Object.keys(queue.transitionReport?.proposed ?? {}), ["archived"]);
    assert.equal(queue.transitionReport?.proposed.archived?.length, 1);
    assert.equal(queue.transitionReport?.proposed.archived?.[0]?.memoryId, "fact-1");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service maintenance uses namespace-scoped health metadata", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-maintenance-namespace-"));
  try {
    const globalDir = memoryDir;
    const projectDir = path.join(memoryDir, "namespaces", "project-x");
    await mkdir(path.dirname(getMemoryProjectionPath(projectDir)), { recursive: true });
    await writeFile(getMemoryProjectionPath(projectDir), "");

    const globalStorage = new StorageManager(globalDir);
    const projectStorage = new StorageManager(projectDir);
    const service = new EngramAccessService({
      config: {
        memoryDir: globalDir,
        namespacesEnabled: true,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
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
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async (namespace?: string) => (namespace === "project-x" ? projectStorage : globalStorage),
    } as any);

    const maintenance = await service.maintenance("project-x", "project-x");
    assert.equal(maintenance.namespace, "project-x");
    assert.equal(maintenance.health.memoryDir, projectDir);
    assert.equal(maintenance.health.projectionAvailable, true);

    const globalMaintenance = await service.maintenance("global", "test-user");
    assert.equal(globalMaintenance.health.memoryDir, globalDir);
    assert.equal(globalMaintenance.health.projectionAvailable, false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service governanceRun skips entity synthesis refresh in shadow mode", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-shadow-synthesis-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    let synthesisCalls = 0;
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "default",
        searchBackend: "qmd",
        qmdEnabled: false,
        nativeKnowledge: undefined,
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [],
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
      processEntitySynthesisQueue: async () => {
        synthesisCalls += 1;
        throw new Error("shadow mode must not refresh synthesis");
      },
    } as any);

    const result = await service.governanceRun({ mode: "shadow" });
    assert.equal(result.mode, "shadow");
    assert.equal(synthesisCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service governanceRun preserves apply result when entity synthesis refresh fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-apply-synthesis-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    let synthesisCalls = 0;
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "default",
        searchBackend: "qmd",
        qmdEnabled: false,
        nativeKnowledge: undefined,
        sharedNamespace: "shared",
        principalFromSessionKeyMode: "prefix",
        principalFromSessionKeyRules: [],
        namespacePolicies: [],
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
      processEntitySynthesisQueue: async () => {
        synthesisCalls += 1;
        throw new Error("synthetic refresh failure");
      },
    } as any);

    const result = await service.governanceRun({ mode: "apply" });
    assert.equal(result.mode, "apply");
    assert.equal(synthesisCalls, 1);
    assert.match(result.runId, /^gov-/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service maps trust-zone promotion validation failures to input errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-trust-zone-promote-"));
  try {
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
        trustZonesEnabled: true,
        quarantinePromotionEnabled: true,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => ({ dir: memoryDir }),
    } as any);

    await assert.rejects(
      () => service.trustZonePromote({
        recordId: "tz-missing",
        targetZone: "trusted",
        promotionReason: "Operator approved",
        recordedAt: "2026-03-08T00:05:00.000Z",
      }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        err.message === "source trust-zone record not found: tz-missing",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service maps invalid trust-zone demo seed requests to input errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-trust-zone-seed-"));
  try {
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
        trustZonesEnabled: true,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => ({ dir: memoryDir }),
    } as any);

    await assert.rejects(
      () => service.trustZoneDemoSeed({ scenario: "bogus-scenario" }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        err.message === "unsupported trust-zone demo scenario: bogus-scenario",
    );

    await assert.rejects(
      () => service.trustZoneDemoSeed({ recordedAt: "2026-03-30Tbad" }),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        err.message === "recordedAt must be a valid ISO timestamp",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service trust-zone browse reports promotions as blocked when promotion is disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-trust-zone-browse-disabled-"));
  try {
    await recordTrustZoneRecord({
      memoryDir,
      record: {
        schemaVersion: 1,
        recordId: "tz-working-demo",
        zone: "working",
        recordedAt: "2026-03-08T00:00:00.000Z",
        kind: "state",
        summary: "Anchored working record.",
        provenance: {
          sourceClass: "tool_output",
          observedAt: "2026-03-08T00:00:00.000Z",
          sourceId: "tool:deploy",
          evidenceHash: "sha256:deploy",
        },
        entityRefs: ["deploy:47"],
        tags: ["release-47"],
      },
    });
    await recordTrustZoneRecord({
      memoryDir,
      record: {
        schemaVersion: 1,
        recordId: "tz-working-corroboration",
        zone: "working",
        recordedAt: "2026-03-08T00:01:00.000Z",
        kind: "external",
        summary: "Corroborating ticket.",
        provenance: {
          sourceClass: "web_content",
          observedAt: "2026-03-08T00:01:00.000Z",
          sourceId: "https://tickets.example.com/CHG-47",
          evidenceHash: "sha256:chg-47",
        },
        entityRefs: ["deploy:47"],
        tags: ["release-47"],
      },
    });

    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
        trustZonesEnabled: true,
        quarantinePromotionEnabled: false,
        memoryPoisoningDefenseEnabled: true,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => ({ dir: memoryDir }),
    } as any);

    const browse = await service.trustZoneBrowse({ zone: "working", limit: 10 });
    const target = browse.records.find((record) => record.recordId === "tz-working-demo");
    assert.ok(target);
    assert.equal(target.nextPromotionTarget, "trusted");
    assert.equal(target.nextPromotionAllowed, false);
    assert.match((target.nextPromotionReasons ?? []).join(" "), /quarantinePromotionEnabled=true/i);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 3 (#396): briefing() must reject invalid window tokens
// ──────────────────────────────────────────────────────────────────────────

function createBriefingService() {
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
          name: "restricted-ns",
          readPrincipals: ["trusted-agent"],
          writePrincipals: ["trusted-agent"],
        },
      ],
      defaultRecallNamespaces: ["global"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      briefing: {
        enabled: true,
        defaultWindow: "yesterday",
        defaultFormat: "markdown",
        maxFollowups: 0,
        calendarSource: null,
        saveByDefault: false,
        saveDir: null,
        llmFollowups: false,
      },
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({
      readAllMemories: async () => [],
      readAllEntityFiles: async () => [],
      ensureDirectories: async () => {},
    }),
  };
  return new EngramAccessService(orchestrator as any);
}

test("briefing() rejects invalid since token with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ since: "3x", principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /invalid briefing window/.test(err.message),
  );
});

test("briefing() rejects invalid since token even when a default exists", async () => {
  const service = createBriefingService();
  // The explicit since value overrides the config default — it must be validated.
  await assert.rejects(
    () => service.briefing({ since: "99z" }),
    (err: unknown) => err instanceof EngramAccessInputError,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Focus filter validation (#396 Codex follow-up): `parseBriefingFocus` returns
// null for malformed values like "project:" (empty suffix). `briefing()` must
// reject these explicitly so a templating miss in automation cannot silently
// broaden a targeted project briefing into an unscoped, all-memories briefing.
// ──────────────────────────────────────────────────────────────────────────

test("briefing() rejects malformed focus filter 'project:' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ focus: "project:", principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /invalid briefing focus filter/.test(err.message),
  );
});

test("briefing() rejects malformed focus filter 'topic:' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ focus: "topic:", principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /invalid briefing focus filter/.test(err.message),
  );
});

test("briefing() accepts undefined focus (no filter applied)", async () => {
  const service = createBriefingService();
  // No focus supplied — the briefing should build normally.
  const result = await service.briefing({ principal: "test-user" });
  assert.ok(result, "briefing should succeed with no focus filter");
});

test("briefing() accepts empty-string focus as 'no filter'", async () => {
  const service = createBriefingService();
  // Empty / whitespace-only string is treated as absent, not malformed.
  const result = await service.briefing({ focus: "   ", principal: "test-user" });
  assert.ok(result, "briefing should succeed with whitespace-only focus");
});

test("briefing() accepts a well-formed focus filter 'project:remnic-core'", async () => {
  const service = createBriefingService();
  const result = await service.briefing({ focus: "project:remnic-core", principal: "test-user" });
  assert.ok(result, "briefing should succeed with a valid focus filter");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 6 (#396): briefing() uses caller principal for namespace access
// ──────────────────────────────────────────────────────────────────────────

test("briefing() rejects when namespace is not readable by the caller principal", async () => {
  const service = createBriefingService();
  // "untrusted-agent" is not in the readPrincipals for "restricted-ns"
  await assert.rejects(
    () =>
      service.briefing({
        namespace: "restricted-ns",
        principal: "untrusted-agent",
      }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /namespace is not readable/.test(err.message),
  );
});

test("briefing() allows access when namespace is readable by the caller principal", async () => {
  const service = createBriefingService();
  // "trusted-agent" is in readPrincipals for "restricted-ns"
  const result = await service.briefing({
    namespace: "restricted-ns",
    principal: "trusted-agent",
  });
  assert.equal(result.namespace, "restricted-ns");
});

// ──────────────────────────────────────────────────────────────────────────
// PRRT_kwDORJXyws56U_7P: Reject unsupported briefing formats in access service
// ──────────────────────────────────────────────────────────────────────────
// Direct / programmatic callers bypass CLI and MCP pre-validation layers.
// Passing an unknown format must raise EngramAccessInputError rather than
// silently falling back to the configured default format.

test("briefing() rejects unsupported format 'jsno' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ format: "jsno" as never, principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /unsupported briefing format/.test(err.message) &&
      err.message.includes("jsno"),
  );
});

test("briefing() rejects unsupported format 'xml' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ format: "xml" as never, principal: "test-user" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /unsupported briefing format/.test(err.message),
  );
});

test("briefing() rejects unsupported format 'text' with EngramAccessInputError", async () => {
  const service = createBriefingService();
  await assert.rejects(
    () => service.briefing({ format: "text" as never }),
    (err: unknown) => err instanceof EngramAccessInputError,
  );
});

test("briefing() accepts valid format 'markdown' without error", async () => {
  const service = createBriefingService();
  const result = await service.briefing({ format: "markdown", principal: "test-user" });
  assert.equal(result.format, "markdown", "valid markdown format must be accepted");
});

test("briefing() accepts valid format 'json' without error", async () => {
  const service = createBriefingService();
  const result = await service.briefing({ format: "json", principal: "test-user" });
  assert.equal(result.format, "json", "valid json format must be accepted");
});

test("briefing() accepts absent format (undefined) without error and uses default", async () => {
  const service = createBriefingService();
  // No format supplied — should use config.briefing.defaultFormat ("markdown").
  const result = await service.briefing({ principal: "test-user" });
  assert.ok(
    result.format === "markdown" || result.format === "json",
    "absent format must resolve to the configured default",
  );
});
