/**
 * Tests for the recall disclosure-depth plumbing introduced in PR 1/4 of
 * issue #677.  Covers:
 *
 *  - Type-level constants (`DEFAULT_RECALL_DISCLOSURE`,
 *    `RECALL_DISCLOSURE_LEVELS`).
 *  - The `isRecallDisclosure()` type guard.
 *  - The zod `recallRequestSchema` accept/reject behavior for the new
 *    `disclosure` field.
 *
 * Surface-level tests (CLI / HTTP / MCP) live with their respective surface
 * suites and ship in PR 2/4.  Auto-escalation tests ship in PR 4/4.
 *
 * All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECALL_DISCLOSURE,
  RECALL_DISCLOSURE_LEVELS,
  isRecallDisclosure,
} from "./types.js";
import { recallRequestSchema, validateRequest } from "./access-schema.js";

test("RECALL_DISCLOSURE_LEVELS is ordered chunk -> section -> raw", () => {
  // Order matters for future escalation policy comparisons (PR 4/4).  The
  // ladder must be stable; freezing here so a refactor that flips order is
  // caught immediately.
  assert.deepStrictEqual(
    [...RECALL_DISCLOSURE_LEVELS],
    ["chunk", "section", "raw"],
  );
});

test("DEFAULT_RECALL_DISCLOSURE is 'chunk' (preserves pre-#677 behavior)", () => {
  assert.strictEqual(DEFAULT_RECALL_DISCLOSURE, "chunk");
});

test("isRecallDisclosure() accepts the three valid levels", () => {
  for (const level of RECALL_DISCLOSURE_LEVELS) {
    assert.strictEqual(isRecallDisclosure(level), true, `level=${level}`);
  }
});

test("isRecallDisclosure() rejects unknown strings, casing variants, and non-strings", () => {
  for (const bad of ["", "Chunk", "CHUNK", "section ", "full", "raw_excerpt", "tier"]) {
    assert.strictEqual(isRecallDisclosure(bad), false, `bad=${JSON.stringify(bad)}`);
  }
  for (const bad of [null, undefined, 0, 1, true, false, {}, []]) {
    assert.strictEqual(isRecallDisclosure(bad as unknown), false);
  }
});

test("recallRequestSchema: omitting disclosure is valid (default applied at service layer)", () => {
  const result = recallRequestSchema.safeParse({ query: "hello" });
  assert.strictEqual(result.success, true);
  if (result.success) {
    assert.strictEqual(result.data.disclosure, undefined);
  }
});

test("recallRequestSchema: each documented disclosure level is accepted", () => {
  for (const level of RECALL_DISCLOSURE_LEVELS) {
    const result = recallRequestSchema.safeParse({ query: "hello", disclosure: level });
    assert.strictEqual(result.success, true, `level=${level}`);
    if (result.success) {
      assert.strictEqual(result.data.disclosure, level);
    }
  }
});

test("recallRequestSchema: invalid disclosure is rejected with field-level error", () => {
  const result = recallRequestSchema.safeParse({ query: "hello", disclosure: "full" });
  assert.strictEqual(result.success, false);
});

test("validateRequest('recall') surfaces disclosure validation errors with structured detail", () => {
  const outcome = validateRequest("recall", { query: "hello", disclosure: "verbose" });
  assert.strictEqual(outcome.success, false);
  if (!outcome.success) {
    assert.strictEqual(outcome.error.code, "validation_error");
    const fields = outcome.error.details.map((d) => d.field);
    assert.ok(fields.includes("disclosure"), `expected disclosure field error, got ${JSON.stringify(fields)}`);
  }
});
