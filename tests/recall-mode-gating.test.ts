import test from "node:test";
import assert from "node:assert/strict";
import {
  hasIdentityRecoveryIntent,
  resolveEffectiveIdentityInjectionMode,
  resolveEffectiveRecallMode,
} from "../src/orchestrator.js";

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

test("resolveEffectiveRecallMode broad intent can escalate to graph_mode when enabled", () => {
  const mode = resolveEffectiveRecallMode({
    plannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    graphExpandedIntentEnabled: true,
    prompt: "How did we get here with recall regressions?",
  });
  assert.equal(mode, "graph_mode");
});

test("hasIdentityRecoveryIntent detects recovery/continuity phrasing", () => {
  assert.equal(hasIdentityRecoveryIntent("We need continuity recovery right now"), true);
  assert.equal(hasIdentityRecoveryIntent("run the lint check"), false);
});

test("resolveEffectiveIdentityInjectionMode gates recovery_only when no explicit intent", () => {
  const result = resolveEffectiveIdentityInjectionMode({
    configuredMode: "recovery_only",
    recallMode: "full",
    prompt: "what did we decide for API retries?",
  });
  assert.deepEqual(result, { mode: "recovery_only", shouldInject: false });
});

test("resolveEffectiveIdentityInjectionMode allows recovery_only when explicit intent is present", () => {
  const result = resolveEffectiveIdentityInjectionMode({
    configuredMode: "recovery_only",
    recallMode: "full",
    prompt: "identity continuity drift happened again, recover the anchor",
  });
  assert.deepEqual(result, { mode: "recovery_only", shouldInject: true });
});

test("resolveEffectiveIdentityInjectionMode downgrades full to minimal under minimal recall mode", () => {
  const result = resolveEffectiveIdentityInjectionMode({
    configuredMode: "full",
    recallMode: "minimal",
    prompt: "reload gateway",
  });
  assert.deepEqual(result, { mode: "minimal", shouldInject: true });
});
