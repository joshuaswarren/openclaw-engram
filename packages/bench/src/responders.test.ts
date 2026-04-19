import assert from "node:assert/strict";
import test from "node:test";

import {
  createGatewayResponder,
  createProviderBackedJudge,
  createProviderBackedResponder,
  createResponderFromProvider,
  createStructuredJudgeFromProvider,
} from "./responders.ts";
import type { LlmProvider } from "./providers/types.ts";

function createFakeProvider(resultText: string): LlmProvider {
  let inputTokens = 0;
  let outputTokens = 0;

  return {
    id: "fake:test-model",
    name: "test-model",
    provider: "openai",
    async complete(prompt) {
      inputTokens += prompt.length;
      outputTokens += resultText.length;
      return {
        text: resultText,
        tokens: {
          input: prompt.length,
          output: resultText.length,
        },
        latencyMs: 12,
        model: "test-model",
      };
    },
    getUsage() {
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    },
    resetUsage() {
      inputTokens = 0;
      outputTokens = 0;
    },
  };
}

test("responder wrappers adapt a provider instance into answer-generation and judge surfaces", async () => {
  const responderProvider = createFakeProvider("final answer");
  const responder = createResponderFromProvider(responderProvider);
  const response = await responder.respond("What is the plan?", "Stored memory context");

  assert.equal(response.text, "final answer");
  assert.equal(response.tokens.input > 0, true);
  assert.equal(response.tokens.output > 0, true);
  assert.equal(response.latencyMs, 12);

  const judgeProvider = createFakeProvider("0.82");
  const judge = createProviderBackedJudge({ provider: "openai", model: "gpt-5.4-mini" }, judgeProvider);
  const score = await judge.score("q", "predicted", "expected");
  assert.equal(score, 0.82);
  const judgeResult = await judge.scoreWithMetrics?.("q", "predicted", "expected");
  assert.equal(judgeResult?.score, 0.82);
  assert.equal(judgeResult?.tokens.input > 0, true);
  assert.equal(judgeResult?.tokens.output > 0, true);
  assert.equal(judgeResult?.latencyMs, 12);
  assert.equal(judgeResult?.model, "test-model");

  const structuredProvider = createFakeProvider("{\"identity_accuracy\":0.9,\"stance_coherence\":0.8,\"novelty\":0.7,\"calibration\":0.6,\"notes\":\"ok\"}");
  const structuredJudge = createStructuredJudgeFromProvider(structuredProvider);
  const raw = await structuredJudge.evaluate({
    system: "judge-system",
    user: "judge-user",
    rubricId: "assistant-rubric-v1",
    taskId: "task-1",
  });
  assert.match(raw, /identity_accuracy/);
});

test("provider-backed responder factories reject invalid configs and produce typed wrappers", () => {
  assert.throws(
    () => createProviderBackedResponder({ provider: "openai", model: "" } as never),
    /provider-backed responder requires a non-empty model/i,
  );

  assert.throws(
    () => createProviderBackedJudge({ provider: "openai", model: "" } as never),
    /provider-backed judge requires a non-empty model/i,
  );

  const responder = createProviderBackedResponder({
    provider: "openai",
    model: "gpt-5.4-mini",
  });
  assert.equal(typeof responder.respond, "function");
});

test("gateway responder requires gateway config", () => {
  assert.throws(
    () => createGatewayResponder({}),
    /gateway responder requires gatewayConfig/i,
  );
});

test("provider-backed judge parses fraction and percent score formats", async () => {
  const fractionJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("8/10"),
  );
  assert.equal(await fractionJudge.score("q", "predicted", "expected"), 0.8);

  const extendedFractionJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Score: 7/20"),
  );
  assert.equal(await extendedFractionJudge.score("q", "predicted", "expected"), 0.35);

  const percentJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("75%"),
  );
  assert.equal(await percentJudge.score("q", "predicted", "expected"), 0.75);

  const outOfJudge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Score: 8 out of 10"),
  );
  assert.equal(await outOfJudge.score("q", "predicted", "expected"), 0.8);
});

test("provider-backed judge ignores date-like fractions and uses the trailing score", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Reviewed on 2026/04/19. Final score: 0.4"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.4);
});

test("provider-backed judge does not treat month/day text as a slash score", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Reviewed on 4/20. Final score: 0.4"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.4);
});

test("provider-backed judge rejects date-like slash triplets before trailing scores", async () => {
  const judge = createProviderBackedJudge(
    { provider: "openai", model: "gpt-5.4-mini" },
    createFakeProvider("Reviewed on 4/5/2026. Final score: 0.4"),
  );

  assert.equal(await judge.score("q", "predicted", "expected"), 0.4);
});
