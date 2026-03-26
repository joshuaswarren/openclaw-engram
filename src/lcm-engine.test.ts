import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LcmEngine } from "./lcm/engine.js";
import type { PluginConfig } from "./types.js";

function createPluginConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    model: "test-model",
    reasoningEffort: "none",
    triggerMode: "smart",
    bufferMaxTurns: 10,
    bufferMaxMinutes: 10,
    consolidateEveryN: 10,
    highSignalPatterns: [],
    maxMemoryTokens: 2048,
    qmdEnabled: false,
    qmdCollection: "test",
    qmdMaxResults: 5,
    qmdTierMigrationEnabled: false,
    qmdTierDemotionMinAgeDays: 30,
    qmdTierDemotionValueThreshold: 0.1,
    qmdTierPromotionValueThreshold: 0.9,
    qmdTierParityGraphEnabled: false,
    qmdTierParityHiMemEnabled: false,
    qmdTierAutoBackfillEnabled: false,
    embeddingFallbackEnabled: false,
    embeddingFallbackProvider: "auto",
    openaiApiKey: undefined,
    openaiBaseUrl: undefined,
    debug: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    identityInjectionMode: "minimal",
    identityMaxInjectChars: 0,
    continuityIncidentLoggingEnabled: false,
    continuityAuditEnabled: false,
    injectQuestions: false,
    commitmentDecayDays: 30,
    workspaceDir: memoryDir,
    captureMode: "implicit",
    agentAccessHttp: {
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes: 1024,
    },
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 1,
    boostAccessCount: false,
    recordEmptyRecallImpressions: false,
    queryExpansionEnabled: false,
    queryExpansionMaxQueries: 0,
    queryExpansionMinTokenLen: 0,
    rerankEnabled: false,
    rerankProvider: "local",
    rerankMaxCandidates: 0,
    rerankTimeoutMs: 0,
    rerankCacheEnabled: false,
    rerankCacheTtlMs: 0,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    negativeExamplesPenaltyPerHit: 0,
    negativeExamplesPenaltyCap: 0,
    chunkingEnabled: false,
    chunkingTargetTokens: 0,
    chunkingMinTokens: 0,
    chunkingOverlapSentences: 0,
    contradictionDetectionEnabled: false,
    contradictionSimilarityThreshold: 0,
    contradictionMinConfidence: 0,
    contradictionAutoResolve: false,
    memoryLinkingEnabled: false,
    threadingEnabled: false,
    threadingGapMinutes: 0,
    summarizationEnabled: false,
    summarizationTriggerCount: 0,
    summarizationRecentToKeep: 0,
    summarizationImportanceThreshold: 0,
    summarizationProtectedTags: [],
    topicExtractionEnabled: false,
    topicExtractionTopN: 0,
    transcriptEnabled: false,
    transcriptRetentionDays: 0,
    transcriptSkipChannelTypes: [],
    transcriptRecallHours: 0,
    maxTranscriptTurns: 0,
    maxTranscriptTokens: 0,
    checkpointEnabled: false,
    checkpointTurns: 0,
    compactionResetEnabled: false,
    hourlySummariesEnabled: false,
    daySummaryEnabled: false,
    hourlySummaryCronAutoRegister: false,
    summaryRecallHours: 0,
    maxSummaryCount: 0,
    summaryModel: "test-model",
    hourlySummariesExtendedEnabled: false,
    hourlySummariesIncludeToolStats: false,
    hourlySummariesIncludeSystemMessages: false,
    hourlySummariesMaxTurnsPerRun: 0,
    conversationIndexEnabled: false,
    lcmEnabled: true,
    lcmLeafBatchSize: 1,
    lcmRollupFanIn: 4,
    lcmFreshTailTurns: 16,
    lcmMaxDepth: 5,
    lcmDeterministicMaxTokens: 128,
    lcmArchiveRetentionDays: 90,
    lcmRecallBudgetShare: 0.15,
  } as unknown as PluginConfig;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("observeMessages resolves before summarize finishes and background worker persists results", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-engine-"));
  const summarizeStarted = deferred<void>();
  const releaseSummarize = deferred<void>();
  let summarizeCalls = 0;

  try {
    const engine = new LcmEngine(
      createPluginConfig(memoryDir),
      async (text, targetTokens, aggressive) => {
        summarizeCalls += 1;
        summarizeStarted.resolve();
        await releaseSummarize.promise;
        return `summary:${aggressive ? "aggressive" : "normal"}:${targetTokens}:${text.length}`;
      },
    );

    const observePromise = engine.observeMessages("session-1", [{ role: "user", content: "hello queued world" }]);
    await observePromise;

    await summarizeStarted.promise;
    assert.equal(engine.observeQueueInFlightCount, 1);

    const beforeRelease = await engine.searchContextFull("hello", 10, "session-1");
    assert.equal(beforeRelease.length, 1);
    assert.equal(beforeRelease[0]?.content.includes("hello queued world"), true);

    releaseSummarize.resolve();
    await engine.waitForObserveQueueIdle();

    assert.equal(summarizeCalls, 1);
    assert.equal(engine.observeQueueInFlightCount, 0);
    assert.equal(engine.observeQueueDepth, 0);

    const afterRelease = await engine.searchContextFull("queued", 10, "session-1");
    assert.equal(afterRelease.length, 1);

    const summary = await engine.describeContext("session-1", 0, 0);
    assert.equal(summary?.summary.startsWith("summary:"), true);
    assert.equal(summary?.turn_count, 1);
    assert.equal(summary?.depth, 0);
  } finally {
    releaseSummarize.resolve();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
