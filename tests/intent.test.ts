import test from "node:test";
import assert from "node:assert/strict";
import { planRecallMode } from "../src/intent.ts";

test("planRecallMode keeps acknowledgements in no_recall", () => {
  assert.equal(planRecallMode("ok"), "no_recall");
  assert.equal(planRecallMode("thanks"), "no_recall");
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
