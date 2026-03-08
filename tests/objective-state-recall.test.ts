import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { recordObjectiveStateSnapshot } from "../src/objective-state.js";

async function buildObjectiveStateRecallHarness(options: {
  objectiveStateRecallEnabled: boolean;
  recallSectionEnabled?: boolean;
}) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-recall-"));
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-npm-failure",
      recordedAt: "2026-03-07T10:00:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "process",
      changeKind: "failed",
      scope: "npm test",
      summary: "Verification run failed with 3 test failures in npm test.",
      toolName: "exec_command",
      command: "npm test",
      outcome: "failure",
      tags: ["verification", "tests"],
    },
  });

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    objectiveStateRecallEnabled: options.objectiveStateRecallEnabled,
    recallPipeline: [
      {
        id: "objective-state",
        enabled: options.recallSectionEnabled ?? true,
        maxResults: 2,
        maxChars: 1200,
      },
    ],
  });

  return new Orchestrator(cfg);
}

test("recall injects objective-state section when retrieval is enabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: true,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.match(context, /## Objective State/);
  assert.match(context, /Verification run failed with 3 test failures in npm test/i);
  assert.equal(context.includes("## Relevant Memories"), false);
});

test("recall omits objective-state section when retrieval flag is disabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.equal(context.includes("## Objective State"), false);
});

test("recall omits objective-state section when pipeline section is disabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: true,
    recallSectionEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.equal(context.includes("## Objective State"), false);
});
