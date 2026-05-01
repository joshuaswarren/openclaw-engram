import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";

test("custom recallPipeline reorders sections and can disable transcript injection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-pipeline-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: false,
    knowledgeIndexEnabled: false,
    identityContinuityEnabled: false,
    transcriptEnabled: true,
    hourlySummariesEnabled: true,
    injectQuestions: true,
    recallPipeline: [
      { id: "questions", enabled: true },
      { id: "profile", enabled: true },
      { id: "summaries", enabled: true },
      { id: "transcript", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  (orchestrator as any).storageRouter = {
    storageFor: async () => ({
      readProfile: async () => "Prefers concise, direct responses.",
      readQuestions: async () => [
        {
          id: "q-1",
          question: "Should we split this into smaller PR slices?",
          context: "Recent review cadence has been slow.",
          priority: 0.9,
          created: new Date().toISOString(),
          status: "open",
        },
      ],
    }),
  };

  (orchestrator as any).summarizer = {
    readRecent: async () => [{ summary: "Summary body", hour: "2026-02-28T19:00:00.000Z" }],
    formatForRecall: () => "## Hourly Summaries\n\n- Summary body",
  };

  (orchestrator as any).transcript = {
    loadCheckpoint: async () => ({ turns: [{ role: "user", content: "TRANSCRIPT_SHOULD_NOT_APPEAR" }] }),
    clearCheckpoint: async () => undefined,
    readRecent: async () => [{ role: "user", content: "TRANSCRIPT_SHOULD_NOT_APPEAR" }],
    formatForRecall: () => "TRANSCRIPT_SHOULD_NOT_APPEAR",
  };

  const context = await (orchestrator as any).recallInternal(
    "What did we decide about slicing PRs?",
    "user:test:recall-pipeline",
  );

  const qIndex = context.indexOf("## Open Question");
  const pIndex = context.indexOf("## User Profile");
  const sIndex = context.indexOf("## Hourly Summaries");

  assert.equal(qIndex >= 0, true);
  assert.equal(pIndex >= 0, true);
  assert.equal(sIndex >= 0, true);
  assert.equal(qIndex < pIndex, true);
  assert.equal(pIndex < sIndex, true);
  assert.equal(context.includes("TRANSCRIPT_SHOULD_NOT_APPEAR"), false);
});

test("disabled explicit-cue pipeline section skips LCM cue retrieval work", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-pipeline-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: false,
    knowledgeIndexEnabled: false,
    identityContinuityEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    explicitCueRecallEnabled: true,
    lcmEnabled: true,
    recallPipeline: [
      { id: "explicit-cue", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async () => {
      throw new Error("explicit cue search should not run");
    },
    expandContext: async () => {
      throw new Error("explicit cue expansion should not run");
    },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "What happened at Turn 450?",
    "user:test:recall-pipeline",
  );

  assert.equal(context, "");
});
