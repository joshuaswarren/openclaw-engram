/**
 * Tests for `capsule-cli.ts` pure helpers (issue #676 PR 6/6 round-2).
 *
 * Scenarios covered:
 *   1. parseCapsuleMergeOptions returns the raw archive path (tilde expansion
 *      is the caller's responsibility — done in cli.ts).
 *   2. parseCapsuleListOptions forwards --dir without modification (caller
 *      expands tilde).
 *   3. parseCapsuleListOptions falls back to defaultDir when --dir is omitted.
 *   4. capsule-cli.ts does NOT import `os` (unused import removed).
 *   5. parseCapsuleInspectOptions returns the archive argument as-is.
 *   6. defaultCapsulesDir appends ".capsules" to the memory dir.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCapsuleMergeOptions,
  parseCapsuleListOptions,
  parseCapsuleInspectOptions,
  defaultCapsulesDir,
} from "./capsule-cli.js";

// ─── 1. parseCapsuleMergeOptions preserves tilde in returned archive ───────────

test("parseCapsuleMergeOptions preserves tilde path for caller to expand", () => {
  const result = parseCapsuleMergeOptions(
    "~/backups/my-capsule.capsule.json.gz",
    {},
  );
  assert.equal(
    result.archive,
    "~/backups/my-capsule.capsule.json.gz",
    "archive should be returned as-is so caller can expand tilde",
  );
  assert.equal(result.conflictMode, "skip-conflicts");
});

test("parseCapsuleMergeOptions with prefer-source conflict mode", () => {
  const result = parseCapsuleMergeOptions(
    "/abs/path.capsule.json.gz",
    { conflictMode: "prefer-source" },
  );
  assert.equal(result.conflictMode, "prefer-source");
});

test("parseCapsuleMergeOptions throws on missing archive", () => {
  assert.throws(
    () => parseCapsuleMergeOptions("", {}),
    /capsule merge.*archive.*required/i,
  );
  assert.throws(
    () => parseCapsuleMergeOptions(undefined, {}),
    /capsule merge.*archive.*required/i,
  );
});

// ─── 2 & 3. parseCapsuleListOptions --dir handling ────────────────────────────

test("parseCapsuleListOptions uses provided --dir without expansion", () => {
  const result = parseCapsuleListOptions(
    { dir: "~/my-capsules", format: "text" },
    "/default/.capsules",
  );
  // Raw tilde preserved — cli.ts calls expandTildePath on the result.
  assert.equal(result.capsulesDir, "~/my-capsules");
  assert.equal(result.format, "text");
});

test("parseCapsuleListOptions falls back to defaultDir when --dir is omitted", () => {
  const result = parseCapsuleListOptions({}, "/memory/.capsules");
  assert.equal(result.capsulesDir, "/memory/.capsules");
  assert.equal(result.format, "text");
});

test("parseCapsuleListOptions rejects unknown format", () => {
  assert.throws(
    () => parseCapsuleListOptions({ format: "xml" }, "/dir"),
    /--format expects one of text, markdown, json/,
  );
});

// ─── 4. capsule-cli.ts does not use `os` ──────────────────────────────────────

test("capsule-cli module does not import node:os (unused import removed)", async () => {
  // Read the source text and verify `os` is not imported.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(dir, "capsule-cli.ts"), "utf-8");
  assert.ok(
    !src.includes("import os from"),
    "capsule-cli.ts must not contain `import os from` (unused import)",
  );
});

// ─── 5. parseCapsuleInspectOptions ────────────────────────────────────────────

test("parseCapsuleInspectOptions returns archive and format", () => {
  const result = parseCapsuleInspectOptions("my-capsule.capsule.json.gz", {});
  assert.equal(result.archive, "my-capsule.capsule.json.gz");
  assert.equal(result.format, "text");
});

test("parseCapsuleInspectOptions throws on missing archive", () => {
  assert.throws(
    () => parseCapsuleInspectOptions("", {}),
    /capsule inspect.*archive.*required/i,
  );
});

// ─── 6. defaultCapsulesDir ────────────────────────────────────────────────────

test("defaultCapsulesDir appends .capsules to memory dir", () => {
  assert.equal(defaultCapsulesDir("/home/user/.memory"), "/home/user/.memory/.capsules");
  assert.equal(defaultCapsulesDir("/tmp/mem"), "/tmp/mem/.capsules");
});
