import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";

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

  const assembled = (orchestrator as any).assembleRecallSections(sectionBuckets);
  const context = assembled.sections.join("\n\n---\n\n");

  assert.equal(assembled.includedIds.includes("memories"), true);
  assert.equal(assembled.truncated, true);
  assert.match(context, /Relevant Memories/);
  assert.ok(context.length <= 220);
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
  global.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
    originalSetTimeout(handler, timeout === 75_000 ? 5 : timeout, ...args)) as typeof setTimeout;

  try {
    const result = await orchestrator.recall("timeout test", "agent:test:timeout", {
      abortSignal: callerAbortController.signal,
    });
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

  const result = await orchestrator.recall("pre-aborted test", "agent:test:preaborted", {
    abortSignal: callerAbortController.signal,
  });

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
  global.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
    originalSetTimeout(handler, timeout === 15_000 ? 100 : timeout, ...args)) as typeof setTimeout;

  try {
    const startedAt = Date.now();
    const recallPromise = orchestrator.recall("init gate abort test", "agent:test:init-gate", {
      abortSignal: callerAbortController.signal,
    });
    setTimeout(() => callerAbortController.abort(), 5);

    const result = await recallPromise;
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result, "");
    assert.equal(recallInternalCalled, false);
    assert.ok(elapsedMs < 80, `expected init gate abort before timeout fallback, saw ${elapsedMs}ms`);
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
  (orchestrator as any).isRecallSectionEnabled = (id: string) => id === "shared-context";
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
  const recallPromise = (orchestrator as any).recallInternal("phase one abort test", "agent:test:phase-one", {
    mode: "full",
    abortSignal: callerAbortController.signal,
  });

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
  assert.ok(elapsedMs < 80, `expected phase-one abort before slow shared-context read completed, saw ${elapsedMs}ms`);
});
