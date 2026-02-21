import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import type { PluginConfig } from "../src/types.js";
import { Orchestrator } from "../src/orchestrator.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function baseConfig(memoryDir: string): PluginConfig {
  return {
    openaiApiKey: undefined,
    model: "gpt-5.2",
    reasoningEffort: "low",
    triggerMode: "smart",
    bufferMaxTurns: 5,
    bufferMaxMinutes: 15,
    consolidateEveryN: 3,
    highSignalPatterns: [],
    maxMemoryTokens: 2000,
    qmdEnabled: false,
    qmdCollection: "openclaw-engram",
    qmdMaxResults: 8,
    memoryDir,
    debug: false,
    identityEnabled: false,
    injectQuestions: false,
    commitmentDecayDays: 90,
    workspaceDir: path.join(memoryDir, "workspace"),
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 0.2,
    boostAccessCount: true,
    queryExpansionEnabled: false,
    queryExpansionMaxQueries: 4,
    queryExpansionMinTokenLen: 3,
    rerankEnabled: false,
    rerankProvider: "local",
    rerankMaxCandidates: 10,
    rerankTimeoutMs: 1000,
    rerankCacheEnabled: true,
    rerankCacheTtlMs: 1000,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    negativeExamplesPenaltyPerHit: 0.05,
    negativeExamplesPenaltyCap: 0.25,
    chunkingEnabled: false,
    chunkingTargetTokens: 200,
    chunkingMinTokens: 150,
    chunkingOverlapSentences: 2,
    contradictionDetectionEnabled: false,
    contradictionSimilarityThreshold: 0.7,
    contradictionMinConfidence: 0.9,
    contradictionAutoResolve: true,
    memoryLinkingEnabled: false,
    threadingEnabled: false,
    threadingGapMinutes: 30,
    summarizationEnabled: false,
    summarizationTriggerCount: 1000,
    summarizationRecentToKeep: 300,
    summarizationImportanceThreshold: 0.3,
    summarizationProtectedTags: [],
    topicExtractionEnabled: false,
    topicExtractionTopN: 50,
    transcriptEnabled: false,
    transcriptRetentionDays: 7,
    transcriptSkipChannelTypes: ["cron"],
    transcriptRecallHours: 12,
    maxTranscriptTurns: 50,
    maxTranscriptTokens: 1000,
    checkpointEnabled: false,
    checkpointTurns: 15,
    hourlySummariesEnabled: false,
    hourlySummaryCronAutoRegister: false,
    summaryRecallHours: 24,
    maxSummaryCount: 6,
    summaryModel: "gpt-5.2",
    hourlySummariesExtendedEnabled: false,
    hourlySummariesIncludeToolStats: false,
    hourlySummariesIncludeSystemMessages: false,
    hourlySummariesMaxTurnsPerRun: 60,
    conversationIndexEnabled: false,
    conversationIndexBackend: "qmd",
    conversationIndexQmdCollection: "openclaw-engram-convo",
    conversationIndexRetentionDays: 14,
    conversationRecallTopK: 3,
    conversationRecallMaxChars: 2000,
    conversationRecallTimeoutMs: 500,
    localLlmEnabled: false,
    localLlmUrl: "http://localhost:1234/v1",
    localLlmModel: "local-model",
    localLlmFallback: true,
    localLlmTimeoutMs: 1000,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
    extractionDedupeEnabled: true,
    extractionDedupeWindowMs: 60_000,
    extractionMinChars: 20,
    extractionMinUserTurns: 1,
    extractionMaxTurnChars: 4000,
    extractionMaxFactsPerRun: 12,
    extractionMaxEntitiesPerRun: 6,
    extractionMaxQuestionsPerRun: 3,
    extractionMaxProfileUpdatesPerRun: 4,
    consolidationRequireNonZeroExtraction: true,
    consolidationMinIntervalMs: 60_000,
    qmdMaintenanceEnabled: true,
    qmdMaintenanceDebounceMs: 500,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 60_000,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 50,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 10_000,
    namespacesEnabled: false,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    namespacePolicies: [],
    defaultRecallNamespaces: ["self"],
    autoPromoteToSharedEnabled: false,
    autoPromoteToSharedCategories: ["correction"],
    autoPromoteMinConfidenceTier: "explicit",
    sharedContextEnabled: true,
    sharedContextDir: path.join(memoryDir, "shared-context"),
    sharedContextMaxInjectChars: 4000,
    crossSignalsSemanticEnabled: false,
    crossSignalsSemanticTimeoutMs: 1000,
    compoundingEnabled: false,
    compoundingWeeklyCronEnabled: false,
    compoundingSemanticEnabled: false,
    compoundingSynthesisTimeoutMs: 1000,
    compoundingInjectEnabled: false,
    recallPlannerEnabled: true,
    recallPlannerMaxQmdResultsMinimal: 1,
    intentRoutingEnabled: false,
    intentRoutingBoost: 0.25,
    verbatimArtifactsEnabled: false,
    verbatimArtifactsMinConfidence: 0.8,
    verbatimArtifactCategories: ["decision", "commitment", "correction", "principle"],
    verbatimArtifactsMaxRecall: 5,
  };
}

test("recallInternal short-circuits no_recall before preamble reads", async () => {
  const memoryDir = tmpDir("engram-no-recall");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  let storageRouterTouched = false;
  (orchestrator as any).storageRouter = {
    storageFor: async () => {
      storageRouterTouched = true;
      throw new Error("storageFor should not run for no_recall");
    },
  };

  const out = await (orchestrator as any).recallInternal("ok", undefined);
  assert.equal(out, "");
  assert.equal(storageRouterTouched, false);
});

test("artifact recall searches all readable namespaces", async () => {
  const memoryDir = tmpDir("engram-artifact-ns");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  cfg.namespacesEnabled = true;
  cfg.defaultNamespace = "default";
  cfg.sharedNamespace = "shared";
  cfg.defaultRecallNamespaces = ["self", "shared"];
  cfg.verbatimArtifactsEnabled = true;

  const orchestrator = new Orchestrator(cfg);
  const touched: string[] = [];
  const mkArtifact = (id: string, content: string) => ({
    path: `/tmp/memory/artifacts/${id}.md`,
    content,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-02-21T00:00:00.000Z",
      updated: "2026-02-21T00:00:00.000Z",
      source: "artifact",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
  });

  (orchestrator as any).storageRouter = {
    storageFor: async (namespace: string) => {
      touched.push(namespace);
      return {
        searchArtifacts: async () =>
          namespace === "shared" ? [mkArtifact("shared-artifact", "shared quote anchor")] : [],
      };
    },
  };
  (orchestrator as any).resolveArtifactSourceStatuses = async () => new Map();

  const artifacts = await (orchestrator as any).recallArtifactsAcrossNamespaces(
    "shared quote",
    ["default", "shared"],
    5,
  );

  assert.equal(touched.includes("default"), true);
  assert.equal(touched.includes("shared"), true);
  assert.equal(artifacts.some((a: any) => a.content.includes("shared quote anchor")), true);
});

test("artifact recall tops up namespace fetch when stale sources are filtered", async () => {
  const memoryDir = tmpDir("engram-artifact-topup");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  const calls: number[] = [];
  const mkArtifact = (id: string, sourceMemoryId?: string) => ({
    path: `/tmp/memory/artifacts/${id}.md`,
    content: id,
    frontmatter: {
      id,
      category: "fact",
      created: "2026-02-21T00:00:00.000Z",
      updated: "2026-02-21T00:00:00.000Z",
      source: "artifact",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      sourceMemoryId,
    },
  });

  (orchestrator as any).storageRouter = {
    storageFor: async () => ({
      searchArtifacts: async (_query: string, maxResults: number) => {
        calls.push(maxResults);
        if (maxResults <= 10) {
          return Array.from({ length: maxResults }, (_, i) =>
            mkArtifact(`stale-${i + 1}`, `s${i + 1}`),
          );
        }
        return [
          mkArtifact("stale-1", "s1"),
          mkArtifact("stale-2", "s2"),
          mkArtifact("active-1", "a1"),
          mkArtifact("active-2", "a2"),
        ];
      },
    }),
  };
  (orchestrator as any).resolveArtifactSourceStatuses = async (_storage: any, ids: string[]) => {
    const map = new Map<string, "active" | "superseded" | "archived" | "missing">();
    for (const id of ids) {
      if (id.startsWith("a")) map.set(id, "active");
      else map.set(id, "superseded");
    }
    return map;
  };

  const results = await (orchestrator as any).fetchActiveArtifactsForNamespace("default", "artifact", 2);
  assert.equal(results.length, 2);
  assert.equal(results.every((m: any) => m.frontmatter.sourceMemoryId?.startsWith("a")), true);
  assert.equal(calls.length >= 2, true);
});

test("qmd fetch tops up when artifact-heavy window underfills non-artifact budget", async () => {
  const memoryDir = tmpDir("engram-qmd-topup");
  await mkdir(memoryDir, { recursive: true });
  const cfg = baseConfig(memoryDir);
  const orchestrator = new Orchestrator(cfg);

  const qmdCalls: number[] = [];
  const mkResult = (path: string, score: number) => ({
    docid: path,
    path,
    snippet: path,
    score,
  });

  (orchestrator as any).qmd = {
    hybridSearch: async (_query: string, _collection: any, maxResults: number) => {
      qmdCalls.push(maxResults);
      if (maxResults <= 8) {
        return Array.from({ length: maxResults }, (_, i) =>
          mkResult(`/tmp/memory/artifacts/${String.fromCharCode(97 + i)}.md`, 1 - i * 0.001),
        );
      }
      return [
        mkResult("/tmp/memory/artifacts/a.md", 1.0),
        mkResult("/tmp/memory/artifacts/b.md", 0.99),
        mkResult("/tmp/memory/artifacts/c.md", 0.98),
        mkResult("/tmp/memory/facts/1.md", 0.97),
        mkResult("/tmp/memory/facts/2.md", 0.96),
        mkResult("/tmp/memory/facts/3.md", 0.95),
      ];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp("topic", 3, 8);
  assert.equal(results.length, 3);
  assert.equal(results.every((r: any) => !r.path.includes("/artifacts/")), true);
  assert.equal(qmdCalls.length >= 2, true);
});
