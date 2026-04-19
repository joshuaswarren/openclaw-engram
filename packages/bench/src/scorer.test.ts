import assert from "node:assert/strict";
import test from "node:test";

import { llmJudgeScoreDetailed } from "./scorer.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("llmJudgeScoreDetailed includes failed score wall time in latency metrics", async () => {
  const result = await llmJudgeScoreDetailed(
    {
      async score() {
        await delay(40);
        throw new Error("judge timeout");
      },
    },
    "question",
    "predicted",
    "expected",
  );

  assert.equal(result.score, -1);
  assert.equal(result.tokens.input, 0);
  assert.equal(result.tokens.output, 0);
  assert.equal(result.latencyMs >= 10, true);
});

test("llmJudgeScoreDetailed includes failed scoreWithMetrics wall time in latency metrics", async () => {
  const result = await llmJudgeScoreDetailed(
    {
      async score() {
        throw new Error("unreachable fallback");
      },
      async scoreWithMetrics() {
        await delay(40);
        throw new Error("structured judge timeout");
      },
    },
    "question",
    "predicted",
    "expected",
  );

  assert.equal(result.score, -1);
  assert.equal(result.tokens.input, 0);
  assert.equal(result.tokens.output, 0);
  assert.equal(result.latencyMs >= 10, true);
});
