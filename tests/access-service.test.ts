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
