import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { synthesizeTrainingPairs } from "./synthesizer.js";
import type { TrainingExportRecord } from "@remnic/core";

function makeRecord(
  overrides: Partial<TrainingExportRecord> = {},
): TrainingExportRecord {
  return {
    instruction: overrides.instruction ?? "general",
    input: overrides.input ?? "",
    output: overrides.output ?? "Some memory content.",
    ...overrides,
  };
}

describe("synthesizeTrainingPairs", () => {
  it("generates pairs from preferences category", () => {
    const records = [
      makeRecord({
        instruction: "preferences/food",
        output: "I love sushi and ramen.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1, "should generate at least one pair");
    // Preference questions should ask about likes/preferences
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("like") || q.includes("preference") || q.includes("favorite"),
      `expected preference-style question, got: "${pairs[0].instruction}"`,
    );
    assert.equal(pairs[0].output, "I love sushi and ramen.");
  });

  it("generates pairs from opinions category", () => {
    const records = [
      makeRecord({
        instruction: "opinions/technology",
        output: "TypeScript is superior to plain JavaScript for large projects.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("think") || q.includes("feel") || q.includes("opinion"),
      `expected opinion-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates pairs from expertise category", () => {
    const records = [
      makeRecord({
        instruction: "expertise/databases",
        output: "PostgreSQL excels at complex queries and JSONB support.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("know") || q.includes("explain"),
      `expected expertise-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("handles default (unknown) category", () => {
    const records = [
      makeRecord({
        instruction: "misc/random",
        output: "The sky is blue on clear days.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    // Should still produce a valid question
    assert.ok(pairs[0].instruction.length > 0);
    assert.equal(pairs[0].output, "The sky is blue on clear days.");
  });

  it("respects maxPairsPerRecord limit", () => {
    const records = [
      makeRecord({
        instruction: "preferences/music",
        output: "I enjoy jazz, classical, and electronic music.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records, { maxPairsPerRecord: 1 });
    assert.equal(pairs.length, 1);
  });

  it("defaults maxPairsPerRecord to 1", () => {
    const records = [
      makeRecord({
        instruction: "preferences/food",
        output: "I like pizza.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);
    assert.equal(pairs.length, 1);
  });

  it("applies style markers - lowercase output", () => {
    const records = [
      makeRecord({
        instruction: "preferences/food",
        output: "I Love Sushi.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records, {
      styleMarkers: {
        avgSentenceLength: 5,
        usesEmoji: false,
        formality: "casual",
        usesLowercase: true,
        commonPhrases: [],
      },
    });

    assert.ok(pairs.length >= 1);
    assert.equal(pairs[0].output, pairs[0].output.toLowerCase());
  });

  it("preserves input field as empty string", () => {
    const records = [
      makeRecord({
        instruction: "preferences/color",
        output: "Blue is my favorite color.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);
    assert.equal(pairs[0].input, "");
  });

  it("handles multiple records", () => {
    const records = [
      makeRecord({ instruction: "preferences/food", output: "I like pizza." }),
      makeRecord({ instruction: "opinions/tech", output: "Rust is fast." }),
      makeRecord({ instruction: "expertise/math", output: "Pi is irrational." }),
    ];

    const pairs = synthesizeTrainingPairs(records);
    assert.equal(pairs.length, 3);
  });

  it("generates pairs from personal category", () => {
    const records = [
      makeRecord({
        instruction: "personal/hobbies",
        output: "I enjoy hiking on weekends.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("your"),
      `expected personal-style question, got: "${pairs[0].instruction}"`,
    );
  });
});
