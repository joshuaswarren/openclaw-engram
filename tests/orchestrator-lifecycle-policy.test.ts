import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("runConsolidation applies lifecycle policy metadata and writes metrics", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-lifecycle-policy-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-lifecycle-workspace-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      topicExtractionEnabled: false,
      summarizationEnabled: false,
      identityEnabled: false,
      entitySummaryEnabled: false,
      lifecyclePolicyEnabled: true,
      lifecycleMetricsEnabled: true,
      lifecyclePromoteHeatThreshold: 0.5,
      lifecycleStaleDecayThreshold: 0.6,
      lifecycleArchiveDecayThreshold: 0.85,
      lifecycleProtectedCategories: ["decision", "principle", "commitment", "preference"],
    });

    const orchestrator = new Orchestrator(config) as any;
    const storage = orchestrator.storage;

    // Avoid LLM consolidation calls in this integration test.
    orchestrator.extraction = {
      consolidate: async () => ({ items: [], profileUpdates: [], entityUpdates: [] }),
    };

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await storage.writeMemory("fact", `memory-${i}`, { source: "test" });
      ids.push(id);
    }

    // Force one very old memory to validate stale/archived scoring behavior.
    await storage.updateMemoryFrontmatter(ids[0], {
      updated: "2010-01-01T00:00:00.000Z",
      lastAccessed: "2010-01-01T00:00:00.000Z",
      confidenceTier: "speculative",
    });

    await orchestrator.runConsolidationNow();

    const memories = await storage.readAllMemories();
    assert.equal(memories.length >= 5, true);
    assert.equal(memories.every((m: any) => typeof m.frontmatter.lifecycleState === "string"), true);
    assert.equal(memories.every((m: any) => typeof m.frontmatter.lastValidatedAt === "string"), true);
    assert.equal(memories.every((m: any) => typeof m.frontmatter.heatScore === "number"), true);
    assert.equal(memories.every((m: any) => typeof m.frontmatter.decayScore === "number"), true);

    const metricsRaw = await readFile(path.join(memoryDir, "state", "lifecycle-metrics.json"), "utf-8");
    const metrics = JSON.parse(metricsRaw) as any;
    assert.equal(metrics.memoriesEvaluated >= 5, true);
    assert.equal(typeof metrics.memoriesUpdated, "number");
    assert.equal(typeof metrics.countsByLifecycleState, "object");
    assert.equal(typeof metrics.staleRatio, "number");
    assert.equal(typeof metrics.disputedRatio, "number");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
