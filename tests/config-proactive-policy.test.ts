import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets proactive/policy-learning defaults", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.proactiveExtractionEnabled, false);
  assert.equal(cfg.contextCompressionActionsEnabled, false);
  assert.equal(cfg.compressionGuidelineLearningEnabled, false);
  assert.equal(cfg.maxProactiveQuestionsPerExtraction, 2);
  assert.equal(cfg.maxCompressionTokensPerHour, 1500);
});

test("parseConfig supports explicit proactive/policy-learning settings and preserves zero limits", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    proactiveExtractionEnabled: true,
    contextCompressionActionsEnabled: true,
    compressionGuidelineLearningEnabled: true,
    maxProactiveQuestionsPerExtraction: 0,
    maxCompressionTokensPerHour: 0,
  });

  assert.equal(cfg.proactiveExtractionEnabled, true);
  assert.equal(cfg.contextCompressionActionsEnabled, true);
  assert.equal(cfg.compressionGuidelineLearningEnabled, true);
  assert.equal(cfg.maxProactiveQuestionsPerExtraction, 0);
  assert.equal(cfg.maxCompressionTokensPerHour, 0);
});

test("parseConfig clamps proactive/policy-learning numeric limits to non-negative integers", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    maxProactiveQuestionsPerExtraction: -1.7,
    maxCompressionTokensPerHour: -500.9,
  });

  assert.equal(cfg.maxProactiveQuestionsPerExtraction, 0);
  assert.equal(cfg.maxCompressionTokensPerHour, 0);
});
