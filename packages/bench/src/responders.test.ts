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
