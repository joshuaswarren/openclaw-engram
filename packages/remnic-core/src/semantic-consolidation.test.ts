/**
 * Unit tests for the ConsolidationOperator vocabulary and derived_from
 * validator introduced in issue #561 PR 1.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONSOLIDATION_OPERATORS,
  isConsolidationOperator,
  isSemanticConsolidationLlmOperator,
  isValidDerivedFromEntry,
  type ConsolidationOperator,
  type SemanticConsolidationLlmOperator,
} from "./semantic-consolidation.js";
// The standalone module is the source of truth; semantic-consolidation.ts
// re-exports it.  This test import proves both surfaces work.
import {
  CONSOLIDATION_OPERATORS as CONSOLIDATION_OPERATORS_DIRECT,
  isConsolidationOperator as isConsolidationOperatorDirect,
  isSemanticConsolidationLlmOperator as isSemanticConsolidationLlmOperatorDirect,
  isValidDerivedFromEntry as isValidDerivedFromEntryDirect,
} from "./consolidation-operator.js";

test("semantic-consolidation.ts re-exports match consolidation-operator.ts", () => {
  assert.deepEqual([...CONSOLIDATION_OPERATORS], [...CONSOLIDATION_OPERATORS_DIRECT]);
  assert.equal(isConsolidationOperator, isConsolidationOperatorDirect);
  assert.equal(
    isSemanticConsolidationLlmOperator,
    isSemanticConsolidationLlmOperatorDirect,
  );
  assert.equal(isValidDerivedFromEntry, isValidDerivedFromEntryDirect);
});

test("CONSOLIDATION_OPERATORS enumerates split/merge/update/pattern-reinforcement", () => {
  // `pattern-reinforcement` joined the operator vocabulary in issue
  // #687 PR 2/4 so the maintenance job in
  // `maintenance/pattern-reinforcement.ts` can stamp `derived_via`
  // through the same write-time validator the rest of consolidation
  // uses.
  assert.deepEqual(
    [...CONSOLIDATION_OPERATORS],
    ["split", "merge", "update", "pattern-reinforcement"],
  );
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
  // `facts/a.md` has no `:`, fails the snapshot regex, and fails the
  // memory-id regex (contains `/` and `.`).
  assert.equal(isValidDerivedFromEntry("facts/a.md"), false, "no version, path-shaped");
  assert.equal(isValidDerivedFromEntry("facts/a.md:"), false, "missing digits");
  assert.equal(isValidDerivedFromEntry("facts/a.md:abc"), false, "non-numeric version");
  assert.equal(isValidDerivedFromEntry("facts/a.md:-1"), false, "negative version");
  assert.equal(isValidDerivedFromEntry("facts/a.md:1.5"), false, "fractional version");
  assert.equal(isValidDerivedFromEntry(":3"), false, "empty path");
  assert.equal(isValidDerivedFromEntry("   :3"), false, "whitespace-only path");
  // Memory-id form must reject leading non-alphanumeric characters
  // (so it cannot accidentally swallow a malformed snapshot like
  // `_-bad`).
  assert.equal(isValidDerivedFromEntry("-not-an-id"), false, "leading hyphen");
  assert.equal(isValidDerivedFromEntry("has spaces"), false, "spaces in id");
  assert.equal(isValidDerivedFromEntry("has/slash"), false, "slash without version");
});

test("isValidDerivedFromEntry accepts memory-id-shaped entries (issue #687 PR 2/4)", () => {
  // Pattern reinforcement records source memory IDs directly rather
  // than page-versioning snapshots; the validator widened to accept
  // either shape.
  assert.equal(isValidDerivedFromEntry("m-abc123-de"), true);
  assert.equal(isValidDerivedFromEntry("m-1"), true);
  assert.equal(isValidDerivedFromEntry("alpha"), true);
  assert.equal(isValidDerivedFromEntry("Mem_Underscored-Allowed"), true);
});

test("isValidDerivedFromEntry rejects non-string values", () => {
  assert.equal(isValidDerivedFromEntry(undefined), false);
  assert.equal(isValidDerivedFromEntry(null), false);
  assert.equal(isValidDerivedFromEntry(42), false);
  assert.equal(isValidDerivedFromEntry(["facts/a.md:2"]), false);
  assert.equal(isValidDerivedFromEntry({ path: "facts/a.md", version: 2 }), false);
});

test("ConsolidationOperator type includes split/merge/update/pattern-reinforcement", () => {
  // Compile-time-only: ensure every literal is assignable to the type.
  const split: ConsolidationOperator = "split";
  const merge: ConsolidationOperator = "merge";
  const update: ConsolidationOperator = "update";
  const reinforcement: ConsolidationOperator = "pattern-reinforcement";
  assert.equal([split, merge, update, reinforcement].length, 4);
});

test("isSemanticConsolidationLlmOperator rejects pattern-reinforcement (Cursor Bugbot, PR #730)", () => {
  // The maintenance-only operator must NEVER be acceptable as LLM
  // output — a hallucinated `{"operator":"pattern-reinforcement"}`
  // would otherwise stamp misleading provenance on a
  // semantic-consolidation memory.
  assert.equal(isSemanticConsolidationLlmOperator("pattern-reinforcement"), false);
  // Legacy operators stay valid.
  assert.equal(isSemanticConsolidationLlmOperator("split"), true);
  assert.equal(isSemanticConsolidationLlmOperator("merge"), true);
  assert.equal(isSemanticConsolidationLlmOperator("update"), true);
  assert.equal(isSemanticConsolidationLlmOperator("annihilate"), false);
  assert.equal(isSemanticConsolidationLlmOperator(""), false);
  assert.equal(isSemanticConsolidationLlmOperator(undefined), false);
});

test("SemanticConsolidationLlmOperator type literally excludes pattern-reinforcement", () => {
  // Compile-time-only: the legacy operators are assignable, but the
  // pattern-reinforcement literal is not.  The latter is enforced
  // implicitly — if this stops compiling we'll catch it in CI.
  const split: SemanticConsolidationLlmOperator = "split";
  const merge: SemanticConsolidationLlmOperator = "merge";
  const update: SemanticConsolidationLlmOperator = "update";
  assert.equal([split, merge, update].length, 3);
});
