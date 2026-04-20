import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { longMemEvalDefinition, runLongMemEvalBenchmark } from "./runner.ts";

/**
 * Smoke test for the LongMemEval runner after issue #566 PR 2 migrated
 * the per-item lifecycle into the shared harness. Verifies:
 *
 *   1. Dataset → plan → harness path emits one task per item.
 *   2. `search_hits` is computed via the post-answer hook (so it uses
 *      the live system under test, not a pre-ingest state).
 *   3. Task IDs, expected answers, and extra detail fields are
 *      propagated faithfully.
 */
test("LongMemEval runner wires the shared harness with per-item postAnswerHook", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-lme-"));
  try {
    await writeFile(
      path.join(tempDir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "q-1",
          question_type: "single-session-user",
          question: "Which city does the user live in?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_sessions: [
            [
              { role: "user", content: "I live in Paris." },
              { role: "assistant", content: "Got it, Paris." },
            ],
          ],
          haystack_session_ids: ["s-1"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["s-1"],
        },
      ]),
      "utf8",
    );

    let searchCalls = 0;
    const result = await runLongMemEvalBenchmark({
      benchmark: longMemEvalDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall(_sessionId, _question) {
          return "I live in Paris.";
        },
        async search(_query, _limit) {
          searchCalls += 1;
          return [{ id: "r", text: "Paris" }];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question, recalled) {
            return {
              text: `${question}:${recalled}`,
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "smoke-responder",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "smoke-judge",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    const task = result.results.tasks[0]!;
    assert.equal(task.taskId, "qq-1");
    assert.equal(task.expected, "Paris");
    assert.equal(task.scores.search_hits, 1);
    assert.equal(
      searchCalls,
      1,
      "search should be invoked exactly once via postAnswerHook",
    );
    // Verify extra details were propagated.
    assert.equal(
      (task.details as Record<string, unknown>).questionType,
      "single-session-user",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
