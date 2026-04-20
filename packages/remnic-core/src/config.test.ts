import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";

// ── PR #394 Bug 2: parseConfig must coerce string "false" for installExtension

test('parseConfig codex.installExtension="false" (string) → false (boolean)', () => {
  const result = parseConfig({ codex: { installExtension: "false" } });
  assert.equal(
    result.codex.installExtension,
    false,
    'string "false" must be coerced to boolean false',
  );
});

test('parseConfig codex.installExtension="0" (string) → false', () => {
  const result = parseConfig({ codex: { installExtension: "0" } });
  assert.equal(result.codex.installExtension, false);
});

test('parseConfig codex.installExtension="no" (string) → false', () => {
  const result = parseConfig({ codex: { installExtension: "no" } });
  assert.equal(result.codex.installExtension, false);
});

test('parseConfig codex.installExtension="FALSE" (uppercase string) → false', () => {
  const result = parseConfig({ codex: { installExtension: "FALSE" } });
  assert.equal(result.codex.installExtension, false);
});

test("parseConfig codex.installExtension=false (boolean) → false", () => {
  const result = parseConfig({ codex: { installExtension: false } });
  assert.equal(result.codex.installExtension, false);
});

test("parseConfig codex.installExtension=true (boolean) → true", () => {
  const result = parseConfig({ codex: { installExtension: true } });
  assert.equal(result.codex.installExtension, true);
});

test('parseConfig codex.installExtension="true" (string) → true', () => {
  const result = parseConfig({ codex: { installExtension: "true" } });
  assert.equal(result.codex.installExtension, true);
});

test("parseConfig codex.installExtension missing → defaults to true", () => {
  const result = parseConfig({ codex: {} });
  assert.equal(result.codex.installExtension, true);
});

test("parseConfig codex missing entirely → installExtension defaults to true", () => {
  const result = parseConfig({});
  assert.equal(result.codex.installExtension, true);
});

test("parseConfig dreaming.maxEntries=0 preserves the runtime disable switch", () => {
  const result = parseConfig({ dreaming: { maxEntries: 0 } });
  assert.equal(result.dreaming.maxEntries, 0);
});

test("parseConfig dreaming.maxEntries=5 falls back to the documented default", () => {
  const result = parseConfig({ dreaming: { maxEntries: 5 } });
  assert.equal(result.dreaming.maxEntries, 500);
});

test("parseConfig dreaming.maxEntries=-5 falls back to the documented default", () => {
  const result = parseConfig({ dreaming: { maxEntries: -5 } });
  assert.equal(result.dreaming.maxEntries, 500);
});

test("parseConfig activeRecallCacheTtlMs=0 disables the active-recall cache", () => {
  const result = parseConfig({ activeRecallCacheTtlMs: 0 });
  assert.equal(result.activeRecallCacheTtlMs, 0);
});

test("parseConfig activeRecallCacheTtlMs=500 preserves the explicit positive ttl", () => {
  const result = parseConfig({ activeRecallCacheTtlMs: 500 });
  assert.equal(result.activeRecallCacheTtlMs, 500);
});

test("parseConfig activeRecallCacheTtlMs=-1 falls back to the default ttl", () => {
  const result = parseConfig({ activeRecallCacheTtlMs: -1 });
  assert.equal(result.activeRecallCacheTtlMs, 15000);
});

test("parseConfig preserves custom entity schemas without code changes", () => {
  const result = parseConfig({
    entitySchemas: {
      person: {
        sections: [
          { key: "beliefs", title: "Beliefs" },
          { key: "working_on", title: "Working On" },
        ],
      },
    },
  });

  assert.deepEqual((result as any).entitySchemas?.person?.sections, [
    { key: "beliefs", title: "Beliefs", description: "" },
    { key: "working_on", title: "Working On", description: "" },
  ]);
});

// ── Issue #518: direct-answer retrieval tier config ─────────────────────────

test("parseConfig recallDirectAnswerEnabled defaults to true (slice 8a flip)", () => {
  const result = parseConfig({});
  assert.equal(result.recallDirectAnswerEnabled, true);
});

test('parseConfig recallDirectAnswerEnabled coerces string "true" to boolean true', () => {
  const result = parseConfig({ recallDirectAnswerEnabled: "true" });
  assert.equal(result.recallDirectAnswerEnabled, true);
});

test('parseConfig recallDirectAnswerEnabled coerces string "false" to boolean false (rule 36)', () => {
  const result = parseConfig({ recallDirectAnswerEnabled: "false" });
  assert.equal(result.recallDirectAnswerEnabled, false);
});

test("parseConfig recallDirectAnswerEnabled accepts boolean true", () => {
  const result = parseConfig({ recallDirectAnswerEnabled: true });
  assert.equal(result.recallDirectAnswerEnabled, true);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor defaults to 0.55", () => {
  const result = parseConfig({});
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.55);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor=0 is preserved as disable switch (rule 45)", () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: 0 });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor=0.8 preserves the explicit value", () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: 0.8 });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.8);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor=-0.1 falls back to default", () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: -0.1 });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.55);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor=1.5 falls back to default", () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: 1.5 });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.55);
});

test('parseConfig recallDirectAnswerTokenOverlapFloor="0.8" (string) coerces to 0.8 (rule 28)', () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: "0.8" });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.8);
});

test('parseConfig recallDirectAnswerTokenOverlapFloor="0" (string) coerces to 0', () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: "0" });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0);
});

test('parseConfig recallDirectAnswerTokenOverlapFloor="not-a-number" falls back to default', () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: "not-a-number" });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.55);
});

test('parseConfig recallDirectAnswerImportanceFloor="0.9" (string) coerces to 0.9', () => {
  const result = parseConfig({ recallDirectAnswerImportanceFloor: "0.9" });
  assert.equal(result.recallDirectAnswerImportanceFloor, 0.9);
});

test('parseConfig recallDirectAnswerAmbiguityMargin="0.25" (string) coerces to 0.25', () => {
  const result = parseConfig({ recallDirectAnswerAmbiguityMargin: "0.25" });
  assert.equal(result.recallDirectAnswerAmbiguityMargin, 0.25);
});

test("parseConfig recallDirectAnswerImportanceFloor defaults to 0.7", () => {
  const result = parseConfig({});
  assert.equal(result.recallDirectAnswerImportanceFloor, 0.7);
});

test("parseConfig recallDirectAnswerImportanceFloor=0 is preserved as disable switch", () => {
  const result = parseConfig({ recallDirectAnswerImportanceFloor: 0 });
  assert.equal(result.recallDirectAnswerImportanceFloor, 0);
});

test("parseConfig recallDirectAnswerAmbiguityMargin defaults to 0.15", () => {
  const result = parseConfig({});
  assert.equal(result.recallDirectAnswerAmbiguityMargin, 0.15);
});

test("parseConfig recallDirectAnswerAmbiguityMargin=0.3 preserves explicit value", () => {
  const result = parseConfig({ recallDirectAnswerAmbiguityMargin: 0.3 });
  assert.equal(result.recallDirectAnswerAmbiguityMargin, 0.3);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets defaults to the documented list", () => {
  const result = parseConfig({});
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, [
    "decisions",
    "principles",
    "conventions",
    "runbooks",
    "entities",
  ]);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets preserves a custom array", () => {
  const result = parseConfig({
    recallDirectAnswerEligibleTaxonomyBuckets: ["decisions", "runbooks"],
  });
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, [
    "decisions",
    "runbooks",
  ]);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets filters non-strings and empty strings", () => {
  const result = parseConfig({
    recallDirectAnswerEligibleTaxonomyBuckets: ["decisions", "", 42, null, "runbooks"],
  });
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, [
    "decisions",
    "runbooks",
  ]);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets=[] is preserved as a disable-all state", () => {
  const result = parseConfig({
    recallDirectAnswerEligibleTaxonomyBuckets: [],
  });
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, []);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets non-array value falls back to default", () => {
  const result = parseConfig({
    recallDirectAnswerEligibleTaxonomyBuckets: "decisions",
  });
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, [
    "decisions",
    "principles",
    "conventions",
    "runbooks",
    "entities",
  ]);
});

// ── Issue #548: local LLM thinking-mode suppression ─────────────────────────

test("parseConfig localLlmDisableThinking defaults to true (issue #548)", () => {
  const result = parseConfig({});
  assert.equal(result.localLlmDisableThinking, true);
});

test("parseConfig localLlmDisableThinking=false preserves operator opt-out", () => {
  const result = parseConfig({ localLlmDisableThinking: false });
  assert.equal(result.localLlmDisableThinking, false);
});

test('parseConfig localLlmDisableThinking="false" (CLI string) coerces to boolean false (rule 36)', () => {
  // `--config localLlmDisableThinking=false` arrives as string; must
  // coerce or the opt-out silently fails.
  const result = parseConfig({ localLlmDisableThinking: "false" });
  assert.equal(result.localLlmDisableThinking, false);
});

test('parseConfig localLlmDisableThinking="true" (CLI string) coerces to boolean true', () => {
  const result = parseConfig({ localLlmDisableThinking: "true" });
  assert.equal(result.localLlmDisableThinking, true);
});

test('parseConfig localLlmDisableThinking "0"/"no"/"off" all coerce to false', () => {
  assert.equal(parseConfig({ localLlmDisableThinking: "0" }).localLlmDisableThinking, false);
  assert.equal(parseConfig({ localLlmDisableThinking: "no" }).localLlmDisableThinking, false);
  assert.equal(parseConfig({ localLlmDisableThinking: "off" }).localLlmDisableThinking, false);
});

test("parseConfig procedural numeric fields coerce from CLI-style strings (issue #519)", () => {
  const result = parseConfig({
    openaiApiKey: "sk-test",
    procedural: {
      enabled: true,
      minOccurrences: "5",
      successFloor: "0.82",
      autoPromoteOccurrences: "12",
      lookbackDays: "14",
      recallMaxProcedures: "2",
    },
  });
  assert.equal(result.procedural.minOccurrences, 5);
  assert.equal(result.procedural.successFloor, 0.82);
  assert.equal(result.procedural.autoPromoteOccurrences, 12);
  assert.equal(result.procedural.lookbackDays, 14);
  assert.equal(result.procedural.recallMaxProcedures, 2);
});

test("parseConfig applies safer-by-default procedural thresholds (issue #567 PR 3/5)", () => {
  // When the user does not override procedural thresholds, the defaults
  // MUST match the safer floor committed in #567 PR 3. This test locks in
  // the values so a future refactor cannot silently regress them.
  // Slice 4 flips `enabled` to true — asserted in the next test.
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(result.procedural.minOccurrences, 3);
  assert.equal(result.procedural.successFloor, 0.75);
  assert.equal(result.procedural.autoPromoteOccurrences, 8);
  assert.equal(result.procedural.lookbackDays, 14);
  assert.equal(result.procedural.recallMaxProcedures, 2);
});

test("parseConfig defaults procedural.enabled to true when omitted (issue #567 PR 4/5)", () => {
  // Omitting `procedural.enabled` ships the feature ON. Users who were
  // previously on the default-off branch get the new default automatically.
  const omitted = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(omitted.procedural.enabled, true);

  // Omitting the `procedural` object entirely is equivalent.
  const bareConfig = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(bareConfig.procedural.enabled, true);

  // Explicit `false` (boolean) still honors opt-out.
  const optOutBool = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: false },
  });
  assert.equal(optOutBool.procedural.enabled, false);

  // CLI-style `"false"` string must also coerce to off (CLAUDE.md rule 36).
  const optOutFalseStr = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: "false" },
  });
  assert.equal(optOutFalseStr.procedural.enabled, false);

  // Other falsy-ish strings also opt out.
  for (const v of ["0", "no", "off"]) {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      procedural: { enabled: v },
    });
    assert.equal(
      cfg.procedural.enabled,
      false,
      `procedural.enabled="${v}" should opt out`,
    );
  }

  // Explicit `true` keeps the feature on (idempotent with the new default).
  const explicitOn = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: true },
  });
  assert.equal(explicitOn.procedural.enabled, true);

  // Unrecognized string values (not a boolean-like string) should NOT flip
  // the default; they're coerced to undefined and fall back to the default.
  const garbage = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: "maybe" },
  });
  assert.equal(garbage.procedural.enabled, true);
});
