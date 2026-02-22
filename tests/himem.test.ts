/**
 * Phase 2B: HiMem – Episode/Note dual store tests
 *
 * Tests for classifyMemoryKind() and reconsolidateNotes() logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

import {
  classifyMemoryKind,
  type MemoryKind,
} from "../src/himem.js";

// ── Helpers ────────────────────────────────────────────────────────────────

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "engram-himem-test-"));
}
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ── classifyMemoryKind ─────────────────────────────────────────────────────

test("classifyMemoryKind: temporal/event language → episode", () => {
  const kind = classifyMemoryKind(
    "User deployed the service to production on Tuesday.",
    [],
    "event",
  );
  assert.equal(kind, "episode");
});

test("classifyMemoryKind: stable preference language → note", () => {
  const kind = classifyMemoryKind(
    "User prefers dark mode in all editors.",
    [],
    "preference",
  );
  assert.equal(kind, "note");
});

test("classifyMemoryKind: decision/constraint language → note", () => {
  const kind = classifyMemoryKind(
    "The project must never use jQuery.",
    [],
    "constraint",
  );
  assert.equal(kind, "note");
});

test("classifyMemoryKind: past tense event with date → episode", () => {
  const kind = classifyMemoryKind(
    "User fixed the auth bug yesterday and pushed to main.",
    ["auth", "bugfix"],
    "decision",
  );
  // Has 'yesterday' — temporal marker → episode
  assert.equal(kind, "episode");
});

test("classifyMemoryKind: generic fact without temporal/stable markers → episode (safe default)", () => {
  const kind = classifyMemoryKind(
    "The app uses PostgreSQL.",
    ["database"],
    "fact",
  );
  // No strong signal either way → episode (safe fallback)
  assert.equal(kind, "episode");
});

test("classifyMemoryKind: 'always' keyword → note", () => {
  const kind = classifyMemoryKind(
    "User always tests in the staging environment before production.",
    [],
    "habit",
  );
  assert.equal(kind, "note");
});

test("classifyMemoryKind: goal/want language → note", () => {
  const kind = classifyMemoryKind(
    "User wants to migrate all services to Kubernetes by end of year.",
    [],
    "goal",
  );
  assert.equal(kind, "note");
});

test("classifyMemoryKind: 'said' / 'mentioned' present but not primary actor → episode", () => {
  const kind = classifyMemoryKind(
    "User mentioned that the deploy failed on Friday.",
    [],
    "event",
  );
  assert.equal(kind, "episode");
});

// ── MemoryKind type safety ─────────────────────────────────────────────────

test("classifyMemoryKind returns only 'episode' or 'note'", () => {
  const validKinds: MemoryKind[] = ["episode", "note"];
  const result = classifyMemoryKind("Some fact.", [], "fact");
  assert.ok(validKinds.includes(result), `unexpected kind: ${result}`);
});
