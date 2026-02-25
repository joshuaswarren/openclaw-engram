import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { runReplayCliCommand, type ReplayCliOrchestrator } from "../src/cli.js";

function openclawJsonlSample(): string {
  return [
    JSON.stringify({
      timestamp: "2026-02-25T10:00:00.000Z",
      role: "user",
      content: "hello",
      sessionKey: "agent:generalist:main",
    }),
    JSON.stringify({
      timestamp: "2026-02-25T10:01:00.000Z",
      role: "assistant",
      content: "hi",
      sessionKey: "agent:generalist:main",
    }),
  ].join("\n");
}

test("runReplayCliCommand dry-run parses but does not enqueue extraction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-"));
  const inputPath = path.join(dir, "replay.jsonl");
  await writeFile(inputPath, openclawJsonlSample(), "utf-8");

  let ingestCalls = 0;
  let waitCalls = 0;
  let consolidationCalls = 0;
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch() {
      ingestCalls += 1;
    },
    async waitForExtractionIdle() {
      waitCalls += 1;
    },
    async runConsolidationNow() {
      consolidationCalls += 1;
      return { memoriesProcessed: 0, merged: 0, invalidated: 0 };
    },
  };

  const summary = await runReplayCliCommand(orchestrator, {
    source: "openclaw",
    inputPath,
    dryRun: true,
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.processedTurns, 2);
  assert.equal(ingestCalls, 0);
  assert.equal(waitCalls, 0);
  assert.equal(consolidationCalls, 0);
});

test("runReplayCliCommand enqueues batches and can run consolidation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-live-"));
  const inputPath = path.join(dir, "replay.jsonl");
  await writeFile(inputPath, openclawJsonlSample(), "utf-8");

  const ingested: number[] = [];
  let waitCalls = 0;
  let consolidationCalls = 0;
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch(turns) {
      ingested.push(turns.length);
    },
    async waitForExtractionIdle() {
      waitCalls += 1;
    },
    async runConsolidationNow() {
      consolidationCalls += 1;
      return { memoriesProcessed: 2, merged: 0, invalidated: 0 };
    },
  };

  const summary = await runReplayCliCommand(orchestrator, {
    source: "openclaw",
    inputPath,
    batchSize: 1,
    runConsolidation: true,
  });

  assert.equal(summary.dryRun, false);
  assert.equal(summary.processedTurns, 2);
  assert.deepEqual(ingested, [1, 1]);
  assert.equal(waitCalls, 1);
  assert.equal(consolidationCalls, 1);
});
