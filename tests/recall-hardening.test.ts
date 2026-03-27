import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import {
  buildQmdRecallCacheKey,
  clearQmdRecallCache,
  getCachedQmdRecall,
  setCachedQmdRecall,
} from "../src/qmd-recall-cache.js";

async function makeOrchestrator(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<Orchestrator> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

function runtimeQmdFetchLimit(
  orchestrator: Orchestrator,
  mode: "full" | "minimal" | "no_recall" = "full",
): number {
  const config = (orchestrator as any).config;
  const baseRecallResultLimit =
    mode === "no_recall"
      ? 0
      : mode === "minimal"
        ? Math.max(
            0,
            Math.min(
              config.qmdMaxResults,
              config.recallPlannerMaxQmdResultsMinimal,
            ),
          )
        : config.qmdMaxResults;
  const memoriesSectionEnabled = (orchestrator as any).isRecallSectionEnabled(
    "memories",
  );
  const memorySectionMaxResults = (orchestrator as any).getRecallSectionNumber(
    "memories",
    "maxResults",
  );
  const recallResultLimit = memoriesSectionEnabled
    ? memorySectionMaxResults !== undefined
      ? Math.min(baseRecallResultLimit, memorySectionMaxResults)
      : baseRecallResultLimit
    : 0;
  const recallHeadroom = config.verbatimArtifactsEnabled
    ? Math.max(12, config.verbatimArtifactsMaxRecall * 4)
    : 12;
  return recallResultLimit === 0
    ? 0
    : Math.max(
        recallResultLimit,
        Math.min(200, recallResultLimit + recallHeadroom),
      );
}

test("assembleRecallSections preserves memories within the recall budget", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-", {
    recallBudgetChars: 220,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });

  const sectionBuckets = new Map<string, string[]>();
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "profile",
    `## User Profile\n\n${"Profile detail ".repeat(30)}`,
  );
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories\n\n- Shared incident context survived the assembly budget.",
  );

  const assembled = (orchestrator as any).assembleRecallSections(
    sectionBuckets,
  );
  const context = assembled.sections.join("\n\n---\n\n");

  assert.equal(assembled.includedIds.includes("memories"), true);
  assert.equal(assembled.truncated, true);
  assert.match(context, /Relevant Memories/);
  assert.ok(context.length <= 220);
});

test("assembleRecallSections does not omit earlier sections when protected sections will truncate anyway", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-tight-", {
    recallBudgetChars: 60,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });

  const sectionBuckets = new Map<string, string[]>();
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "profile",
    "P".repeat(50),
  );
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "memories",
    "M".repeat(50),
  );

  const assembled = (orchestrator as any).assembleRecallSections(
    sectionBuckets,
  );
  const context = assembled.sections.join("\n\n---\n\n");

  assert.deepEqual(assembled.includedIds, ["profile", "memories"]);
  assert.equal(assembled.omittedIds.length, 0);
  assert.equal(assembled.truncated, true);
  assert.ok(context.length <= 60);
});

test("recall aborts the in-flight pipeline when the outer timeout fires", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-timeout-");
  let observedAbortSignal: AbortSignal | undefined;
  const callerAbortController = new AbortController();
  (orchestrator as any).initPromise = null;
  (orchestrator as any).recallInternal = async (
    _prompt: string,
    _sessionKey?: string,
    options: { abortSignal?: AbortSignal } = {},
  ) =>
    await new Promise<string>((_resolve, reject) => {
      observedAbortSignal = options.abortSignal;
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          const err = new Error("recall aborted");
          Object.defineProperty(err, "name", { value: "AbortError" });
          reject(err);
        },
        { once: true },
      );
    });

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ) =>
    originalSetTimeout(
      handler,
      timeout === 75_000 ? 5 : timeout,
      ...args,
    )) as typeof setTimeout;

  try {
    const result = await orchestrator.recall(
      "timeout test",
      "agent:test:timeout",
      {
        abortSignal: callerAbortController.signal,
      },
    );
    assert.equal(result, "");
    assert.ok(observedAbortSignal);
    assert.notEqual(observedAbortSignal, callerAbortController.signal);
    assert.equal(observedAbortSignal?.aborted, true);
    assert.equal(callerAbortController.signal.aborted, false);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("recall propagates an already-aborted external signal to the inner controller", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-preaborted-");
  const callerAbortController = new AbortController();
  callerAbortController.abort();

  let observedAbortSignal: AbortSignal | undefined;
  (orchestrator as any).initPromise = null;
  (orchestrator as any).recallInternal = async (
    _prompt: string,
    _sessionKey?: string,
    options: { abortSignal?: AbortSignal } = {},
  ) => {
    observedAbortSignal = options.abortSignal;
    throw new Error("should not reach active recall work");
  };

  const result = await orchestrator.recall(
    "pre-aborted test",
    "agent:test:preaborted",
    {
      abortSignal: callerAbortController.signal,
    },
  );

  assert.equal(result, "");
  assert.ok(observedAbortSignal);
  assert.notEqual(observedAbortSignal, callerAbortController.signal);
  assert.equal(observedAbortSignal?.aborted, true);
});

test("recall aborts while waiting on the init gate", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-init-gate-abort-");
  const callerAbortController = new AbortController();
  let recallInternalCalled = false;
  (orchestrator as any).initPromise = new Promise<void>(() => {});
  (orchestrator as any).recallInternal = async () => {
    recallInternalCalled = true;
    return "should not run";
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ) =>
    originalSetTimeout(
      handler,
      timeout === 15_000 ? 100 : timeout,
      ...args,
    )) as typeof setTimeout;

  try {
    const startedAt = Date.now();
    const recallPromise = orchestrator.recall(
      "init gate abort test",
      "agent:test:init-gate",
      {
        abortSignal: callerAbortController.signal,
      },
    );
    setTimeout(() => callerAbortController.abort(), 5);

    const result = await recallPromise;
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result, "");
    assert.equal(recallInternalCalled, false);
    assert.ok(
      elapsedMs < 80,
      `expected init gate abort before timeout fallback, saw ${elapsedMs}ms`,
    );
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("cold fallback abort stops before archive scanning", async () => {
  const orchestrator = await makeOrchestrator("engram-cold-fallback-abort-", {
    qmdColdTierEnabled: true,
    qmdEnabled: true,
  });
  const callerAbortController = new AbortController();
  callerAbortController.abort();

  let archiveReads = 0;
  (orchestrator as any).qmd = { isAvailable: () => true };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => [];
  (orchestrator as any).readArchivedMemoriesForNamespaces = async () => {
    archiveReads += 1;
    return [];
  };

  await assert.rejects(
    (orchestrator as any).applyColdFallbackPipeline({
      prompt: "archive abort test",
      recallNamespaces: ["default"],
      recallResultLimit: 5,
      recallMode: "minimal",
      abortSignal: callerAbortController.signal,
    }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(archiveReads, 0);
});

test("recallInternal aborts while phase-one preamble promises are still pending", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-phase-one-abort-");
  const callerAbortController = new AbortController();
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context";
  let releaseSharedRead: (() => void) | null = null;
  let sharedReadStarted = false;
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      sharedReadStarted = true;
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "slow priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };

  const startedAt = Date.now();
  const recallPromise = (orchestrator as any).recallInternal(
    "phase one abort test",
    "agent:test:phase-one",
    {
      mode: "full",
      abortSignal: callerAbortController.signal,
    },
  );

  const waitForStartDeadline = Date.now() + 100;
  while (!sharedReadStarted && Date.now() < waitForStartDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  callerAbortController.abort();

  await assert.rejects(
    recallPromise,
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  const elapsedMs = Date.now() - startedAt;

  releaseSharedRead?.();

  assert.equal(sharedReadStarted, true);
  assert.ok(
    elapsedMs < 80,
    `expected phase-one abort before slow shared-context read completed, saw ${elapsedMs}ms`,
  );
});

test("recallInternal does not launch phase-one preamble work for an already-aborted signal", async () => {
  const orchestrator = await makeOrchestrator(
    "engram-recall-phase-one-preaborted-",
  );
  const callerAbortController = new AbortController();
  callerAbortController.abort();

  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context";
  let sharedReadStarted = false;
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      sharedReadStarted = true;
      return "should not run";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };

  await assert.rejects(
    (orchestrator as any).recallInternal(
      "phase one pre-aborted test",
      "agent:test:phase-one-preaborted",
      {
        mode: "full",
        abortSignal: callerAbortController.signal,
      },
    ),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );

  assert.equal(sharedReadStarted, false);
});

test("recallInternal fails open when qmd enrichment rejects before phase-two assembly", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-qmd-fail-open-", {
    qmdEnabled: true,
  });

  let releaseSharedRead: (() => void) | null = null;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "qmd";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).qmd = {
    isAvailable: () => true,
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => {
    throw new Error("qmd fetch exploded");
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-fail-open",
    { mode: "full" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSharedRead?.();

  const context = await recallPromise;
  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /Relevant Memories/);
});

test("recallInternal reuses stale qmd cache while qmd reprobe cooldown is active", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-stale-cache-",
    {
      qmdEnabled: true,
      qmdRecallCacheTtlMs: 0,
      qmdRecallCacheStaleTtlMs: 60_000,
    },
  );

  const memoryId = await (orchestrator as any).storage.writeMemory(
    "fact",
    "stale cache memory",
  );
  const memory = await (orchestrator as any).storage.getMemoryById(memoryId);
  assert.ok(memory);

  const cacheKey = buildQmdRecallCacheKey({
    query: "Summarize the current project state.",
    namespaces: ["default"],
    recallMode: "full",
    maxResults: runtimeQmdFetchLimit(orchestrator),
    memoryDir: (orchestrator as any).config.memoryDir,
  });
  setCachedQmdRecall(
    cacheKey,
    {
      memoryResultsLists: [
        [
          {
            docid: memory.frontmatter.id,
            path: memory.path,
            snippet: "stale cache memory",
            score: 0.91,
          },
        ],
      ],
      globalResults: [],
      preAugmentTopScore: 0.91,
      maxSpecializedScore: 0,
    },
    { maxEntries: 8 },
  );

  await new Promise((resolve) => setTimeout(resolve, 5));

  (orchestrator as any).qmd = {
    isAvailable: () => false,
    probe: async () => false,
    debugStatus: () => "qmd unavailable",
  };
  (orchestrator as any).lastQmdReprobeAtMs = Date.now();

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-stale-cache",
    { mode: "full" },
  );

  assert.match(context, /stale cache memory/);
});

test("recallInternal uses already-settled qmd results after the enrichment budget expires", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-ready-after-budget-",
    {
      qmdEnabled: true,
      memoryBoxesEnabled: true,
      boxRecallDays: 1,
      recallEnrichmentDeadlineMs: 5,
    },
  );

  const memoryId = await (orchestrator as any).storage.writeMemory(
    "fact",
    "ready qmd memory",
  );
  const memory = await (orchestrator as any).storage.getMemoryById(memoryId);
  assert.ok(memory);

  let releaseBoxes: (() => void) | null = null;
  (orchestrator as any).boxBuilderFor = () => ({
    readRecentBoxes: async () => {
      await new Promise<void>((resolve) => {
        releaseBoxes = resolve;
      });
      return [];
    },
  });

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    probe: async () => true,
    debugStatus: () => "qmd ready",
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => [
    {
      docid: memory.frontmatter.id,
      path: memory.path,
      snippet: "ready qmd memory",
      score: 0.91,
    },
  ];

  setTimeout(() => releaseBoxes?.(), 15);

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-ready-after-budget",
    { mode: "full" },
  );

  assert.match(context, /ready qmd memory/);
});

test("recallInternal does not cache empty qmd result sets", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-empty-cache-",
    {
      qmdEnabled: true,
      qmdRecallCacheTtlMs: 60_000,
      qmdRecallCacheStaleTtlMs: 60_000,
    },
  );

  (orchestrator as any).qmd = {
    isAvailable: () => true,
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () => [];

  await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-empty-cache",
    { mode: "full" },
  );

  const cacheKey = buildQmdRecallCacheKey({
    query: "Summarize the current project state.",
    namespaces: ["default"],
    recallMode: "full",
    maxResults: runtimeQmdFetchLimit(orchestrator),
    memoryDir: (orchestrator as any).config.memoryDir,
  });

  assert.equal(
    getCachedQmdRecall(cacheKey, {
      freshTtlMs: 60_000,
      staleTtlMs: 60_000,
    }),
    null,
  );
});

test("recallInternal times out hung enrichment work without blocking assembly", async () => {
  const orchestrator = await makeOrchestrator(
    "engram-recall-hung-enrichment-",
    {
      compoundingInjectEnabled: true,
      recallEnrichmentDeadlineMs: 5,
      queryAwareIndexingEnabled: false,
      parallelRetrievalEnabled: false,
    },
  );

  let releaseSharedRead: (() => void) | null = null;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "compounding";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).compounding = {
    buildRecallSection: async () => await new Promise<string | null>(() => {}),
  };

  const startedAt = Date.now();
  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:hung-enrichment",
    { mode: "full" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSharedRead?.();

  const context = await recallPromise;
  const elapsedMs = Date.now() - startedAt;

  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /compounding/i);
  assert.ok(
    elapsedMs < 100,
    `expected enrichment timeout to avoid long assembly stalls, saw ${elapsedMs}ms`,
  );
});

test("recallInternal fails open when a deferred enrichment promise rejects before assembly", async () => {
  const orchestrator = await makeOrchestrator(
    "engram-recall-enrichment-fail-open-",
    {
      compoundingInjectEnabled: true,
    },
  );

  let releaseSharedRead: (() => void) | null = null;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "compounding";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).compounding = {
    buildRecallSection: async () => {
      throw new Error("compounding exploded");
    },
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:enrichment-fail-open",
    { mode: "full" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSharedRead?.();

  const context = await recallPromise;
  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /compounding/i);
});

test("recallInternal cancels timed-out qmd enrichment work", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-qmd-timeout-cancel-",
    {
      qmdEnabled: true,
      recallEnrichmentDeadlineMs: 80,
      queryAwareIndexingEnabled: false,
      parallelRetrievalEnabled: false,
    },
  );

  let releaseSharedRead: (() => void) | null = null;
  let observedAbortSignal: AbortSignal | undefined;
  let qmdAborted = false;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "memories";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).qmd = {
    isAvailable: () => true,
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async (
    _query: string,
    _maxResults: number,
    _hybridFetchLimit: number,
    options: { abortSignal?: AbortSignal } = {},
  ) => {
    observedAbortSignal = options.abortSignal;
    if (options.abortSignal?.aborted) {
      qmdAborted = true;
      const err = new Error("qmd enrichment aborted");
      Object.defineProperty(err, "name", { value: "AbortError" });
      throw err;
    }
    await new Promise<never>((_resolve, reject) => {
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          qmdAborted = true;
          const err = new Error("qmd enrichment aborted");
          Object.defineProperty(err, "name", { value: "AbortError" });
          reject(err);
        },
        { once: true },
      );
    });
  };

  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:qmd-timeout-cancel",
    { mode: "full" },
  );

  for (let attempt = 0; attempt < 100 && !observedAbortSignal; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(observedAbortSignal, "expected qmd enrichment to start");
  await new Promise((resolve) => setTimeout(resolve, 90));
  releaseSharedRead?.();

  const context = await recallPromise;
  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /Relevant Memories/);
  assert.ok(observedAbortSignal);
  assert.equal(observedAbortSignal?.aborted, true);
  assert.equal(qmdAborted, true);
});

test("recallInternal shares one enrichment timeout budget across sequential enrichment awaits", async () => {
  clearQmdRecallCache();
  const orchestrator = await makeOrchestrator(
    "engram-recall-shared-enrichment-budget-",
    {
      qmdEnabled: true,
      compoundingInjectEnabled: true,
      recallEnrichmentDeadlineMs: 120,
      queryAwareIndexingEnabled: false,
      parallelRetrievalEnabled: false,
    },
  );

  let releaseSharedRead: (() => void) | null = null;
  let releaseQmd: (() => void) | null = null;
  (orchestrator as any).isRecallSectionEnabled = (id: string) =>
    id === "shared-context" || id === "memories" || id === "compounding";
  (orchestrator as any).sharedContext = {
    readPriorities: async () => {
      await new Promise<void>((resolve) => {
        releaseSharedRead = resolve;
      });
      return "stable shared priorities";
    },
    readLatestRoundtable: async () => null,
    readLatestCrossSignals: async () => null,
  };
  (orchestrator as any).qmd = {
    isAvailable: () => true,
  };
  (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp = async () =>
    await new Promise<[]>((
      resolve,
    ) => {
      releaseQmd = () => resolve([]);
    });
  (orchestrator as any).compounding = {
    buildRecallSection: async () => await new Promise<string | null>(() => {}),
  };

  const startedAt = Date.now();
  const recallPromise = (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "agent:test:shared-enrichment-budget",
    { mode: "full" },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSharedRead?.();
  await new Promise((resolve) => setTimeout(resolve, 70));
  releaseQmd?.();

  const context = await recallPromise;
  const elapsedMs = Date.now() - startedAt;

  assert.match(context, /stable shared priorities/);
  assert.doesNotMatch(context, /compounding/i);
  assert.doesNotMatch(context, /Relevant Memories/);
  assert.ok(
    elapsedMs < 170,
    `expected compounding to share the remaining enrichment budget, saw ${elapsedMs}ms`,
  );
});
