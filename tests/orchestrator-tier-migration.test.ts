import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";

function buildConfig(
  memoryDir: string,
  workspaceDir: string,
  enabled: boolean,
  autoBackfill = true,
) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    topicExtractionEnabled: false,
    summarizationEnabled: false,
    identityEnabled: false,
    entitySummaryEnabled: false,
    qmdTierMigrationEnabled: enabled,
    qmdTierDemotionMinAgeDays: 0,
    qmdTierDemotionValueThreshold: 1,
    qmdTierPromotionValueThreshold: 1,
    qmdTierAutoBackfillEnabled: autoBackfill,
  });
}

test("tier migration cycle demotes hot memory when enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-enabled-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-enabled-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;
    await storage.writeMemory("fact", "demote me", { source: "test" });

    await orchestrator.runTierMigrationCycle(storage, "extraction");

    const hot = await storage.readAllMemories();
    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();
    assert.equal(hot.length, 0);
    assert.equal(cold.length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("tier migration cycle is no-op when disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-disabled-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-disabled-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, false)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;
    await storage.writeMemory("fact", "stay hot", { source: "test" });

    await orchestrator.runTierMigrationCycle(storage, "extraction");

    const hot = await storage.readAllMemories();
    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();
    assert.equal(hot.length, 1);
    assert.equal(cold.length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("tier migration cycle is bounded per maintenance pass", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-bounded-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-bounded-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true, true)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;
    for (let i = 0; i < 260; i += 1) {
      await storage.writeMemory("fact", `memory-${i}`, { source: "test" });
    }

    await orchestrator.runTierMigrationCycle(storage, "maintenance");

    const hot = await storage.readAllMemories();
    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();
    assert.equal(cold.length > 0, true);
    assert.equal(cold.length <= 200, true);
    assert.equal(hot.length + cold.length, 260);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("tier migration extraction scan prioritizes oldest hot memories for demotion", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-oldest-first-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-tier-orch-oldest-first-workspace-"));
  try {
    const orchestrator = new Orchestrator(buildConfig(memoryDir, workspaceDir, true, true)) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };
    const storage = orchestrator.storage;

    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      ids.push(await storage.writeMemory("fact", `memory-${i}`, { source: "test" }));
    }

    const oldIds = ids.slice(0, 12);
    for (const id of oldIds) {
      await storage.updateMemoryFrontmatter(id, {
        updated: "2001-01-01T00:00:00.000Z",
      });
    }

    await orchestrator.runTierMigrationCycle(storage, "extraction");

    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();
    const movedIds = new Set(cold.map((m) => m.frontmatter.id));
    assert.equal(oldIds.some((id) => movedIds.has(id)), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
