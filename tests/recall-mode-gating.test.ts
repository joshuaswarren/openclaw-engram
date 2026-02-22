import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveRecallMode } from "../src/orchestrator.js";

test("resolveEffectiveRecallMode downgrades graph_mode to full when graph recall is disabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: true,
    graphRecallEnabled: false,
    multiGraphMemoryEnabled: true,
    prompt: "what happened in the timeline",
  });
  assert.equal(mode, "full");
});

test("resolveEffectiveRecallMode downgrades graph_mode to full when graph memory is disabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: false,
    prompt: "show the chain of events",
  });
  assert.equal(mode, "full");
});

test("resolveEffectiveRecallMode keeps graph_mode when both graph flags are enabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    prompt: "what happened in the timeline",
  });
  assert.equal(mode, "graph_mode");
});

test("resolveEffectiveRecallMode keeps baseline behavior when planner is disabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: false,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    prompt: "what happened in the timeline",
  });
  assert.equal(mode, "full");
});
