import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { getEvalHarnessStatus } from "../src/evals.js";

async function waitForShadowCount(options: {
  memoryDir: string;
  evalStoreDir: string;
  enabled: boolean;
  shadowModeEnabled: boolean;
  count: number;
}): Promise<Awaited<ReturnType<typeof getEvalHarnessStatus>>> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const status = await getEvalHarnessStatus({
      memoryDir: options.memoryDir,
      evalStoreDir: options.evalStoreDir,
      enabled: options.enabled,
      shadowModeEnabled: options.shadowModeEnabled,
    });
    if (status.shadows.total >= options.count || Date.now() >= deadline) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("shadow recall recording stays off when eval shadow mode is disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-shadow-off-"));
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: false,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const memoryId = await orchestrator.storage.writeMemory("fact", "shadow-disabled memory");
  const memory = await orchestrator.storage.getMemoryById(memoryId);
  assert.ok(memory);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: memory!.frontmatter.id,
        path: memory!.path,
        snippet: "shadow-disabled memory",
        score: 0.9,
      },
    ],
    search: async () => [],
  };

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "session-shadow-disabled",
  );
  assert.match(context, /shadow-disabled memory/);

  const status = await waitForShadowCount({
    memoryDir,
    evalStoreDir: cfg.evalStoreDir,
    enabled: cfg.evalHarnessEnabled,
    shadowModeEnabled: cfg.evalShadowModeEnabled,
    count: 0,
  });

  assert.equal(status.shadows.total, 0);
  assert.equal(status.shadows.invalid, 0);
  assert.equal(status.latestShadow, undefined);
});

test("shadow recall recording writes live recall decisions without changing injected context", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-shadow-on-"));
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const memoryId = await orchestrator.storage.writeMemory("fact", "shadow-recorded memory");
  const memory = await orchestrator.storage.getMemoryById(memoryId);
  assert.ok(memory);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: memory!.frontmatter.id,
        path: memory!.path,
        snippet: "shadow-recorded memory",
        score: 0.9,
      },
    ],
    search: async () => [],
  };

  const context = await (orchestrator as any).recallInternal(
    "Summarize the current project state.",
    "session-shadow-recorded",
  );
  assert.match(context, /shadow-recorded memory/);

  const status = await waitForShadowCount({
    memoryDir,
    evalStoreDir: cfg.evalStoreDir,
    enabled: cfg.evalHarnessEnabled,
    shadowModeEnabled: cfg.evalShadowModeEnabled,
    count: 1,
  });

  assert.equal(status.shadows.total, 1);
  assert.equal(status.shadows.invalid, 0);
  assert.equal(status.shadows.latestSessionKey, "session-shadow-recorded");
  assert.ok(status.latestShadow);
  assert.equal(status.latestShadow?.recalledMemoryCount, 1);
  assert.equal(status.latestShadow?.injected, true);
  assert.deepEqual(status.latestShadow?.memoryIds, [memory!.frontmatter.id]);
});

test("shadow recall recording includes no_recall decisions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-evals-shadow-norecall-"));
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const context = await (orchestrator as any).recallInternal(
    "ok",
    "session-shadow-no-recall",
  );
  assert.equal(context, "");

  const status = await waitForShadowCount({
    memoryDir,
    evalStoreDir: cfg.evalStoreDir,
    enabled: cfg.evalHarnessEnabled,
    shadowModeEnabled: cfg.evalShadowModeEnabled,
    count: 1,
  });

  assert.equal(status.shadows.total, 1);
  assert.ok(status.latestShadow);
  assert.equal(status.latestShadow?.sessionKey, "session-shadow-no-recall");
  assert.equal(status.latestShadow?.recallMode, "no_recall");
  assert.equal(status.latestShadow?.source, "none");
  assert.equal(status.latestShadow?.injected, false);
  assert.deepEqual(status.latestShadow?.memoryIds, []);
});
