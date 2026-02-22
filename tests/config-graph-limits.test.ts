import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig preserves zero graph limits", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    maxGraphTraversalSteps: 0,
    maxEntityGraphEdgesPerMemory: 0,
  });

  assert.equal(cfg.maxGraphTraversalSteps, 0);
  assert.equal(cfg.maxEntityGraphEdgesPerMemory, 0);
});

test("parseConfig clamps negative graph limits to zero", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    maxGraphTraversalSteps: -4,
    maxEntityGraphEdgesPerMemory: -9,
  });

  assert.equal(cfg.maxGraphTraversalSteps, 0);
  assert.equal(cfg.maxEntityGraphEdgesPerMemory, 0);
});

test("parseConfig keeps graphRecallEnabled opt-in", () => {
  const defaults = parseConfig({ openaiApiKey: "sk-test" });
  const enabled = parseConfig({ openaiApiKey: "sk-test", graphRecallEnabled: true });

  assert.equal(defaults.graphRecallEnabled, false);
  assert.equal(enabled.graphRecallEnabled, true);
});
