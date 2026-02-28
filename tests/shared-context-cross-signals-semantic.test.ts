import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { SharedContextManager } from "../src/shared-context/manager.js";

function isoForDate(date: string, time: string): Date {
  return new Date(`${date}T${time}Z`);
}

async function buildManager(prefix: string, semantic: { enabled: boolean; timeoutMs: number; maxCandidates: number }) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-memory-`));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-shared-`));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: true,
    sharedContextDir: sharedDir,
    sharedCrossSignalSemanticEnabled: semantic.enabled,
    sharedCrossSignalSemanticTimeoutMs: semantic.timeoutMs,
    sharedCrossSignalSemanticMaxCandidates: semantic.maxCandidates,
  });
  const manager = new SharedContextManager(config);
  await manager.ensureStructure();
  return { manager, memoryDir, sharedDir };
}

test("shared-context semantic cross-signals adds overlap for related token variants", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-semantic", {
    enabled: true,
    timeoutMs: 2000,
    maxCandidates: 120,
  });
  try {
    const date = "2026-03-04";
    await manager.writeAgentOutput({
      agentId: "generalist",
      title: "Optimization roadmap",
      content: "Planned optimization milestones for cache and batching.",
      createdAt: isoForDate(date, "09:00:00"),
    });
    await manager.writeAgentOutput({
      agentId: "oracle",
      title: "Optimize cache tuning",
      content: "We should optimize cache warmups with staged rollout.",
      createdAt: isoForDate(date, "09:05:00"),
    });
    await manager.writeAgentOutput({
      agentId: "optimizer",
      title: "Optimized cache rollout",
      content: "The rollout is optimized for hot paths.",
      createdAt: isoForDate(date, "09:10:00"),
    });

    const result = await manager.curateDaily({ date });
    const raw = JSON.parse(await readFile(result.crossSignalsPath, "utf-8"));

    assert.equal(raw.semantic.enabled, true);
    assert.equal(raw.semantic.timedOut, false);
    assert.equal(raw.semantic.applied, true);
    assert.equal(raw.semantic.addedOverlapCount >= 1, true);
    assert.equal(raw.overlaps.some((entry: { token: string }) => entry.token.startsWith("semantic:")), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("shared-context semantic cross-signals fail-open on timeout", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-semantic-timeout", {
    enabled: true,
    timeoutMs: 1,
    maxCandidates: 120,
  });
  try {
    const date = "2026-03-05";
    const largeA = Array.from({ length: 8000 }, (_, i) => `optimization${i}`).join(" ");
    const largeB = Array.from({ length: 8000 }, (_, i) => `optimize${i}`).join(" ");
    await manager.writeAgentOutput({
      agentId: "generalist",
      title: "Optimization roadmap",
      content: largeA,
      createdAt: isoForDate(date, "09:00:00"),
    });
    await manager.writeAgentOutput({
      agentId: "oracle",
      title: "Optimize cache tuning",
      content: largeB,
      createdAt: isoForDate(date, "09:05:00"),
    });

    const result = await manager.curateDaily({ date });
    const raw = JSON.parse(await readFile(result.crossSignalsPath, "utf-8"));

    assert.equal(raw.semantic.enabled, true);
    assert.equal(raw.semantic.timedOut, true);
    assert.equal(raw.semantic.applied, false);
    assert.equal(raw.semantic.addedOverlapCount, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});
