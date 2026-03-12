import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";

async function makeOrchestrator(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<Orchestrator> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

test("assembleRecallSections preserves memories within the recall budget", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-budget-", {
    recallBudgetChars: 220,
    recallPipeline: [
      { id: "profile", enabled: true },
      { id: "memories", enabled: true },
    ],
  });

  const sectionBuckets = new Map<string, string[]>();
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "profile",
    `## User Profile\n\n${"Profile detail ".repeat(30)}`,
  );
  (orchestrator as any).appendRecallSection(
    sectionBuckets,
    "memories",
    "## Relevant Memories\n\n- Shared incident context survived the assembly budget.",
  );

  const assembled = (orchestrator as any).assembleRecallSections(sectionBuckets);
  const context = assembled.sections.join("\n\n---\n\n");

  assert.equal(assembled.includedIds.includes("memories"), true);
  assert.equal(assembled.truncated, true);
  assert.match(context, /Relevant Memories/);
  assert.ok(context.length <= 220);
});

test("recall aborts the in-flight pipeline when the outer timeout fires", async () => {
  const orchestrator = await makeOrchestrator("engram-recall-timeout-");
  let observedAbortSignal: AbortSignal | undefined;
  (orchestrator as any).initPromise = null;
  (orchestrator as any).recallInternal = async (
    _prompt: string,
    _sessionKey?: string,
    options: { abortSignal?: AbortSignal } = {},
  ) =>
    await new Promise<string>((_resolve, reject) => {
      observedAbortSignal = options.abortSignal;
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          const err = new Error("recall aborted");
          Object.defineProperty(err, "name", { value: "AbortError" });
          reject(err);
        },
        { once: true },
      );
    });

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
    originalSetTimeout(handler, timeout === 75_000 ? 5 : timeout, ...args)) as typeof setTimeout;

  try {
    const result = await orchestrator.recall("timeout test", "agent:test:timeout");
    assert.equal(result, "");
    assert.ok(observedAbortSignal);
    assert.equal(observedAbortSignal?.aborted, true);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
