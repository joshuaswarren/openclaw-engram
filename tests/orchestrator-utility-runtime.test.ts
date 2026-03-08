import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("boostSearchResults applies bounded utility runtime multipliers to heuristic deltas", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-runtime-rank-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-runtime-rank-workspace-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      recencyWeight: 0,
      boostAccessCount: true,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      intentRoutingEnabled: false,
      queryAwareIndexingEnabled: false,
      lifecyclePolicyEnabled: false,
      lifecycleFilterStaleEnabled: false,
      memoryUtilityLearningEnabled: true,
      promotionByOutcomeEnabled: true,
    });
    const orchestrator = new Orchestrator(config) as any;
    orchestrator.utilityRuntimeValues = {
      rankingBoostMultiplier: 1.12,
      rankingSuppressMultiplier: 0.88,
      promoteThresholdDelta: 0,
      demoteThresholdDelta: 0,
      snapshotUpdatedAt: "2026-03-08T12:00:00.000Z",
    };
    orchestrator.storage = {
      readMemoryByPath: async () => ({
        path: "/tmp/memory/facts/a.md",
        content: "a",
        frontmatter: {
          id: "a",
          category: "fact",
          created: "2026-02-01T00:00:00.000Z",
          updated: "2026-02-01T00:00:00.000Z",
          source: "test",
          confidence: 0.9,
          confidenceTier: "explicit",
          tags: [],
          status: "active",
          accessCount: 9,
          importance: { score: 1 },
        },
      }),
    };

    const [result] = await orchestrator.boostSearchResults([
      { path: "/tmp/memory/facts/a.md", score: 0.5, docid: "a", snippet: "a" },
    ], [], undefined);

    assert.ok(result.score > 0.69);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
