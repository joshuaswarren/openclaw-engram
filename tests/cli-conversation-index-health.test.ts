import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import { runConversationIndexHealthCliCommand } from "../src/cli.js";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("conversation-index-health CLI wrapper returns orchestrator health payload", async () => {
  const expected = {
    enabled: true,
    backend: "qmd" as const,
    status: "ok" as const,
    chunkDocCount: 12,
    lastUpdateAt: "2026-02-27T18:00:00.000Z",
    qmdAvailable: true,
  };

  const result = await runConversationIndexHealthCliCommand({
    async getConversationIndexHealth() {
      return expected;
    },
  });

  assert.deepEqual(result, expected);
});

async function makeOrchestrator(overrides: Record<string, unknown>): Promise<Orchestrator> {
  const memoryDir = tmpDir("engram-conv-health");
  const workspaceDir = path.join(memoryDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    sharedContextEnabled: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

test("orchestrator conversation index health reports qmd backend availability", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "qmd",
  });

  (orchestrator as any).conversationQmd = {
    isAvailable: () => true,
  };

  const health = await orchestrator.getConversationIndexHealth();

  assert.equal(health.enabled, true);
  assert.equal(health.backend, "qmd");
  assert.equal(health.status, "ok");
  assert.equal(health.qmdAvailable, true);
  assert.equal(typeof health.chunkDocCount, "number");
});

test("orchestrator conversation index health reports faiss degradation fail-open", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
  });

  (orchestrator as any).conversationFaiss = {
    async health() {
      throw new Error("sidecar unavailable");
    },
  };

  const health = await orchestrator.getConversationIndexHealth();

  assert.equal(health.enabled, true);
  assert.equal(health.backend, "faiss");
  assert.equal(health.status, "degraded");
  assert.equal(health.faiss?.ok, false);
});

test("orchestrator conversation index health reports disabled state", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: false,
    conversationIndexBackend: "qmd",
  });

  const health = await orchestrator.getConversationIndexHealth();

  assert.equal(health.enabled, false);
  assert.equal(health.status, "disabled");
  assert.equal(health.backend, "qmd");
});
