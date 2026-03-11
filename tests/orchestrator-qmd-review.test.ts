import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { registerTools } from "../src/tools.ts";

const EMPTY_PREFILTER = {
  candidatePaths: null,
  temporalFromDate: null,
  matchedTags: [],
  expandedTags: [],
  combination: "none",
  filteredToFullSearch: false,
} as const;

test("fetchQmdMemoryResultsWithArtifactTopUp forwards QMD search options and skips hybrid top-up under intent hints", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdIntentHintsEnabled: true,
    qmdExplainEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg) as any;

  let searchArgs: unknown[] | null = null;
  let hybridCalls = 0;
  let snapshot: Record<string, unknown> | null = null;
  orchestrator.qmd = {
    search: async (...args: unknown[]) => {
      searchArgs = args;
      return [
        {
          docid: "fact-1",
          path: "facts/2026-03-11/fact-1.md",
          snippet: "fact one",
          score: 0.9,
          transport: "daemon",
        },
      ];
    },
    hybridSearch: async () => {
      hybridCalls += 1;
      return [
        {
          docid: "fact-2",
          path: "facts/2026-03-11/fact-2.md",
          snippet: "fact two",
          score: 0.8,
        },
      ];
    },
  };

  const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp(
    "review the last recall",
    2,
    4,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      collection: "openclaw-engram",
      queryAwarePrefilter: EMPTY_PREFILTER,
      searchOptions: {
        intent: "goal:review action:review entities:repo",
        explain: true,
      },
      onDebugSnapshot: async (payload: Record<string, unknown>) => {
        snapshot = payload;
      },
    },
  );

  assert.equal(hybridCalls, 0);
  assert.deepEqual(searchArgs, [
    "review the last recall",
    "openclaw-engram",
    4,
    {
      intent: "goal:review action:review entities:repo",
      explain: true,
    },
  ]);
  assert.equal(results.length, 1);
  assert.ok(snapshot);
  assert.equal(snapshot?.hybridTopUpSkippedReason, "intent_hint_active");
  assert.equal(snapshot?.intentHint, "goal:review action:review entities:repo");
  assert.equal(snapshot?.explainEnabled, true);
});

test("fetchQmdMemoryResultsWithArtifactTopUp still uses hybrid top-up when no QMD intent hint is present", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-hybrid-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg) as any;

  let hybridCalls = 0;
  orchestrator.qmd = {
    search: async () => [
      {
        docid: "fact-1",
        path: "facts/2026-03-11/fact-1.md",
        snippet: "fact one",
        score: 0.7,
        transport: "subprocess",
      },
    ],
    hybridSearch: async () => {
      hybridCalls += 1;
      return [
        {
          docid: "fact-2",
          path: "facts/2026-03-11/fact-2.md",
          snippet: "fact two",
          score: 0.8,
        },
      ];
    },
  };

  const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp(
    "review the last recall",
    2,
    4,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      collection: "openclaw-engram",
      queryAwarePrefilter: EMPTY_PREFILTER,
    },
  );

  assert.equal(hybridCalls, 1);
  assert.equal(results.length, 2);
});

test("QMD recall snapshot helpers read persisted snapshots and memory_qmd_debug is registered", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-debug-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg);
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "state", "last_qmd_recall.json"),
    JSON.stringify(
      {
        recordedAt: "2026-03-11T12:00:00.000Z",
        queryHash: "query-123",
        queryLength: 24,
        collection: "openclaw-engram",
        namespaces: ["default"],
        fetchLimit: 12,
        primaryResultCount: 5,
        hybridResultCount: 0,
        queryAwareSeedCount: 1,
        resultCount: 3,
        intentHint: "goal:review action:review",
        explainEnabled: true,
        hybridTopUpUsed: false,
        hybridTopUpSkippedReason: "intent_hint_active",
        results: [
          {
            docid: "fact-1",
            path: "facts/2026-03-11/fact-1.md",
            snippet: "fact one",
            score: 0.91,
            transport: "daemon",
            explain: {
              blendedScore: 0.91,
              rerankScore: 0.66,
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );

  const snapshot = await (orchestrator as any).getLastQmdRecallSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.intentHint, "goal:review action:review");

  const explanation = await (orchestrator as any).explainLastQmdRecall();
  assert.match(explanation, /Last QMD Recall/);
  assert.match(explanation, /intent hint/i);
  assert.match(explanation, /hybrid top-up skipped reason/i);

  const tools = new Map<string, {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  }>();
  registerTools({
    registerTool(spec: {
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
    }) {
      tools.set(spec.name, spec);
    },
  } as never, {
    config: {
      defaultNamespace: "default",
      workspaceDir: memoryDir,
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
      identityContinuityEnabled: false,
    },
    explainLastIntent: async () => "noop",
    explainLastQmdRecall: async () => "## Last QMD Recall\n\nIntent hint: goal:review",
    explainLastGraphRecall: async () => "noop",
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    storage: {
      readIdentity: async () => null,
      readProfile: async () => null,
      readAllEntities: async () => [],
      readIdentityAnchor: async () => null,
      writeIdentityAnchor: async () => {},
    },
    getStorageForNamespace: async () => ({
      readProfile: async () => "",
      readIdentityReflections: async () => "",
    }),
    summarizer: {
      runHourly: async () => {},
    },
    transcript: {
      loadCheckpoint: async () => null,
      clearCheckpoint: async () => {},
    },
    searchAcrossNamespaces: async () => [],
  } as never);

  const tool = tools.get("memory_qmd_debug");
  assert.ok(tool);
  const result = await tool.execute("call-1", {});
  const text = result.content.map((item) => item.text).join("\n");
  assert.match(text, /Last QMD Recall/);
  await readFile(path.join(memoryDir, "state", "last_qmd_recall.json"), "utf-8");
});
