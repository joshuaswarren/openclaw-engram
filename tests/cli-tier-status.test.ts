import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  runTierMigrateCliCommand,
  runTierStatusCliCommand,
} from "../src/cli.js";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";

test("runTierStatusCliCommand returns orchestrator status payload", async () => {
  const expected = {
    updatedAt: "2026-02-28T00:00:00.000Z",
    lastCycle: {
      trigger: "manual",
      scanned: 10,
      migrated: 3,
      promoted: 1,
      demoted: 2,
      limit: 5,
      dryRun: true,
    },
    totals: {
      cycles: 4,
      scanned: 42,
      migrated: 9,
      promoted: 3,
      demoted: 6,
      errors: 0,
    },
  };

  const result = await runTierStatusCliCommand({
    async getTierMigrationStatus() {
      return expected;
    },
    async runTierMigrationNow() {
      throw new Error("not used");
    },
  });

  assert.deepEqual(result, expected);
});

test("runTierMigrateCliCommand forwards dry-run and limit", async () => {
  const calls: Array<{ dryRun?: boolean; limit?: number }> = [];
  const result = await runTierMigrateCliCommand(
    {
      async getTierMigrationStatus() {
        return {
          updatedAt: "2026-02-28T00:00:00.000Z",
          lastCycle: null,
          totals: {
            cycles: 0,
            scanned: 0,
            migrated: 0,
            promoted: 0,
            demoted: 0,
            errors: 0,
          },
        };
      },
      async runTierMigrationNow(options) {
        calls.push(options ?? {});
        return {
          trigger: "manual",
          scanned: 20,
          migrated: 2,
          promoted: 1,
          demoted: 1,
          limit: 7,
          dryRun: options?.dryRun === true,
        };
      },
    },
    { dryRun: true, limit: 7 },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { dryRun: true, limit: 7 });
  assert.equal(result.limit, 7);
  assert.equal(result.dryRun, true);
});

test("orchestrator runTierMigrationNow dry-run reports candidates without moving files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-tier-migrate-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-tier-migrate-workspace-"));

  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      qmdTierMigrationEnabled: true,
      qmdTierDemotionMinAgeDays: 0,
      qmdTierDemotionValueThreshold: 1,
      qmdTierPromotionValueThreshold: 1,
    });
    const orchestrator = new Orchestrator(config) as any;
    orchestrator.qmd = {
      updateCollection: async () => {},
      embedCollection: async () => {},
    };

    const storage = orchestrator.storage as StorageManager;
    await storage.writeMemory("fact", "candidate for dry-run migration", { source: "test" });

    const summary = await runTierMigrateCliCommand(orchestrator, { dryRun: true, limit: 1 });
    const hot = await storage.readAllMemories();
    const cold = await new StorageManager(path.join(storage.dir, "cold")).readAllMemories();

    assert.equal(summary.trigger, "manual");
    assert.equal(summary.dryRun, true);
    assert.equal(summary.migrated, 1);
    assert.equal(hot.length, 1);
    assert.equal(cold.length, 0);

    const status = await runTierStatusCliCommand(orchestrator);
    assert.equal(status.lastCycle?.dryRun, true);
    assert.equal(status.lastCycle?.migrated, 1);
    assert.equal(status.totals.cycles >= 1, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
