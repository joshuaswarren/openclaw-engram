/**
 * Unit tests for the ConsolidationOperator vocabulary and derived_from
 * validator introduced in issue #561 PR 1.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONSOLIDATION_OPERATORS,
  isConsolidationOperator,
  isValidDerivedFromEntry,
  type ConsolidationOperator,
} from "./semantic-consolidation.js";

test("CONSOLIDATION_OPERATORS enumerates exactly split/merge/update", () => {
  assert.deepEqual([...CONSOLIDATION_OPERATORS], ["split", "merge", "update"]);
});

test("isConsolidationOperator accepts every defined operator", () => {
  for (const op of CONSOLIDATION_OPERATORS) {
    assert.equal(isConsolidationOperator(op), true, `${op} should be accepted`);
  }
});

test("isConsolidationOperator rejects unknown and non-string values", () => {
  assert.equal(isConsolidationOperator("MERGE"), false); // case-sensitive
  assert.equal(isConsolidationOperator("annihilate"), false);
  assert.equal(isConsolidationOperator(""), false);
  assert.equal(isConsolidationOperator(undefined), false);
  assert.equal(isConsolidationOperator(null), false);
  assert.equal(isConsolidationOperator(42), false);
  assert.equal(isConsolidationOperator({ op: "merge" }), false);
});

test("isValidDerivedFromEntry accepts well-formed path:version strings", () => {
  assert.equal(isValidDerivedFromEntry("facts/a.md:0"), true);
  assert.equal(isValidDerivedFromEntry("facts/a.md:2"), true);
  assert.equal(isValidDerivedFromEntry("facts/2026-01-15/pref-001.md:17"), true);
  assert.equal(isValidDerivedFromEntry("entities/person-alice.md:1"), true);
  // Paths containing colons are still parseable because only the final
  // `:<digits>` is consumed as the version.
  assert.equal(isValidDerivedFromEntry("facts/weird:name.md:3"), true);
});

test("isValidDerivedFromEntry rejects malformed entries", () => {
  assert.equal(isValidDerivedFromEntry(""), false, "empty string");
  assert.equal(isValidDerivedFromEntry("facts/a.md"), false, "no version");
  assert.equal(isValidDerivedFromEntry("facts/a.md:"), false, "missing digits");
  assert.equal(isValidDerivedFromEntry("facts/a.md:abc"), false, "non-numeric version");
  assert.equal(isValidDerivedFromEntry("facts/a.md:-1"), false, "negative version");
  assert.equal(isValidDerivedFromEntry("facts/a.md:1.5"), false, "fractional version");
  assert.equal(isValidDerivedFromEntry(":3"), false, "empty path");
  assert.equal(isValidDerivedFromEntry("   :3"), false, "whitespace-only path");
});

test("isValidDerivedFromEntry rejects non-string values", () => {
  assert.equal(isValidDerivedFromEntry(undefined), false);
  assert.equal(isValidDerivedFromEntry(null), false);
  assert.equal(isValidDerivedFromEntry(42), false);
  assert.equal(isValidDerivedFromEntry(["facts/a.md:2"]), false);
  assert.equal(isValidDerivedFromEntry({ path: "facts/a.md", version: 2 }), false);
});

test("ConsolidationOperator type includes split/merge/update", () => {
  // Compile-time-only: ensure every literal is assignable to the type.
  const split: ConsolidationOperator = "split";
  const merge: ConsolidationOperator = "merge";
  const update: ConsolidationOperator = "update";
  assert.equal([split, merge, update].length, 3);
});
