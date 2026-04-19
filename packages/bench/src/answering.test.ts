import assert from "node:assert/strict";
import test from "node:test";

import { answerBenchmarkQuestion } from "./answering.ts";

test("without a responder the benchmark answer falls back to recalled text", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "The recalled memory.",
  });

  assert.equal(result.finalAnswer, "The recalled memory.");
  assert.equal(result.recalledText, "The recalled memory.");
  assert.equal(result.answeredText, "The recalled memory.");
  assert.deepEqual(result.tokens, {
    input: 0,
    output: 0,
  });
  assert.equal(result.latencyMs, 0);
});

test("with a responder the benchmark answer uses the generated final answer and preserves usage", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "The recalled memory.",
    responder: {
      async respond(question, recalledText) {
        assert.equal(question, "What happened?");
        assert.equal(recalledText, "The recalled memory.");
        return {
          text: "The generated answer.",
          tokens: {
            input: 32,
            output: 9,
          },
          latencyMs: 44,
          model: "gpt-5.4-mini",
        };
      },
    },
  });

  assert.equal(result.finalAnswer, "The generated answer.");
  assert.equal(result.recalledText, "The recalled memory.");
  assert.equal(result.answeredText, "The generated answer.");
  assert.deepEqual(result.tokens, {
    input: 32,
    output: 9,
  });
  assert.equal(result.latencyMs, 44);
  assert.equal(result.model, "gpt-5.4-mini");
});
