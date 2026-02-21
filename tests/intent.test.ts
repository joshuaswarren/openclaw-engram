import test from "node:test";
import assert from "node:assert/strict";
import { inferIntentFromText, planRecallMode } from "../src/intent.ts";

test("planRecallMode keeps acknowledgements in no_recall", () => {
  assert.equal(planRecallMode("ok"), "no_recall");
  assert.equal(planRecallMode("thanks"), "no_recall");
  assert.equal(planRecallMode("ok."), "no_recall");
  assert.equal(planRecallMode("thanks!"), "no_recall");
  assert.equal(planRecallMode("ok,"), "no_recall");
  assert.equal(planRecallMode("thanks:"), "no_recall");
  assert.equal(planRecallMode("got it :)"), "no_recall");
});

test("planRecallMode uses graph_mode for timeline/history prompts", () => {
  assert.equal(planRecallMode("what happened in the timeline"), "graph_mode");
});

test("planRecallMode defaults non-ack prompts to full recall", () => {
  assert.equal(planRecallMode("Summarize last week's key points"), "full");
  assert.equal(planRecallMode("What decisions did we make about the API?"), "full");
});

test("planRecallMode returns minimal for short operational directives", () => {
  assert.equal(planRecallMode("Check gateway status"), "minimal");
  assert.equal(planRecallMode("Reload the gateway"), "minimal");
});

test("inferIntentFromText matches common verb conjugations", () => {
  const inferred = inferIntentFromText("We reviewed and fixed the deploy failures");
  assert.equal(inferred.goal, "stabilize");
  assert.equal(inferred.actionType, "review");
  assert.equal(inferred.entityTypes.includes("repo"), false);
});

test("inferIntentFromText detects decide/plan conjugations", () => {
  const inferred = inferIntentFromText("We decided on planning changes to the roadmap");
  assert.equal(inferred.actionType, "plan");
  assert.equal(inferred.goal, "plan");
});

test("inferIntentFromText recognizes decision/chose variants for decide action", () => {
  const fromDecision = inferIntentFromText("Final decision: choose the safer rollout");
  assert.equal(fromDecision.actionType, "decide");

  const fromChose = inferIntentFromText("We chose this approach for rollout");
  assert.equal(fromChose.actionType, "decide");
});

test("inferIntentFromText recognizes built as execute action", () => {
  const inferred = inferIntentFromText("We built the channel-specific recall patch yesterday");
  assert.equal(inferred.actionType, "execute");
});

test("runtime guards tolerate nullish/non-string inputs", () => {
  assert.doesNotThrow(() => planRecallMode(undefined as unknown as string));
  assert.doesNotThrow(() => planRecallMode(null as unknown as string));
  assert.equal(planRecallMode(undefined as unknown as string), "no_recall");
  assert.equal(planRecallMode(null as unknown as string), "no_recall");

  assert.doesNotThrow(() => inferIntentFromText(undefined as unknown as string));
  assert.doesNotThrow(() => inferIntentFromText(null as unknown as string));
  assert.equal(inferIntentFromText(undefined as unknown as string).goal, "unknown");
  assert.equal(inferIntentFromText(null as unknown as string).actionType, "unknown");
});
