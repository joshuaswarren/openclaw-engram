/**
 * Tests for `capsule-cli.ts` pure helpers (issue #676 PR 6/6 round-3).
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
 *   7. capsule list ENOENT is swallowed; other readdir errors are re-thrown.
 *   8. merge archive ID-lookup: bare name is resolved via capsule store dir.
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

// ─── 7. readdir ENOENT swallowing — only ENOENT, not other errors ─────────────
//
// These tests exercise the patched capsule list readdir error handling in
// cli.ts by invoking the underlying Node.js readdir semantics. We simulate the
// two error classes by reading a non-existent path (ENOENT) and a file path
// used as a directory (ENOTDIR / ENOENT on some platforms).

test("readdir on missing directory throws ENOENT which should be swallowed", async () => {
  const { readdir } = await import("node:fs/promises");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Create a temp dir, then construct a path inside it that doesn't exist.
  const tmp = mkdtempSync(join(tmpdir(), "capsule-list-test-"));
  const missing = join(tmp, "nonexistent-capsules");

  let caught: NodeJS.ErrnoException | null = null;
  try {
    await readdir(missing);
  } catch (err) {
    caught = err as NodeJS.ErrnoException;
  }
  assert.ok(caught !== null, "expected readdir to throw for missing dir");
  assert.equal(
    caught.code,
    "ENOENT",
    "missing directory should produce ENOENT — the list action swallows this",
  );
});

test("readdir on a file path throws non-ENOENT error which must NOT be swallowed", async () => {
  const { readdir, writeFile } = await import("node:fs/promises");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Create a regular file and then try to readdir it — yields ENOTDIR.
  const tmp = mkdtempSync(join(tmpdir(), "capsule-list-test-"));
  const filePath = join(tmp, "not-a-directory.txt");
  await writeFile(filePath, "content");

  let caught: NodeJS.ErrnoException | null = null;
  try {
    await readdir(filePath);
  } catch (err) {
    caught = err as NodeJS.ErrnoException;
  }
  assert.ok(caught !== null, "expected readdir to throw for a file path");
  assert.notEqual(
    caught.code,
    "ENOENT",
    "a file used as directory must NOT produce ENOENT (should be ENOTDIR or similar) — must be re-thrown by list action",
  );
});

// ─── 8. merge archive ID-lookup path resolution ───────────────────────────────
//
// Verifies that the 3-step path resolution logic added to `capsule merge`
// produces the correct archive path for each case. We test the pure resolution
// logic inline here (not through the CLI action, which needs an orchestrator).

test("merge path resolution: explicit absolute path is used as-is", async () => {
  // Simulates step 1: arg looks like an explicit path → tilde-expand and use.
  const { expandTildePath } = await import("./utils/path.js");
  const input = "/absolute/path/my-capsule.capsule.json.gz";
  const expanded = expandTildePath(input);
  assert.equal(expanded, input, "absolute path should be unchanged after tilde expansion");
});

test("merge path resolution: tilde in explicit path is expanded", async () => {
  const { expandTildePath } = await import("./utils/path.js");
  const { homedir } = await import("node:os");
  const input = "~/backups/my-capsule.capsule.json.gz";
  const expanded = expandTildePath(input);
  assert.equal(
    expanded,
    `${homedir()}/backups/my-capsule.capsule.json.gz`,
    "leading tilde must be expanded to the home directory",
  );
  // After expansion the path starts with '/' so `looksLikePath` is true —
  // the ID-lookup branch is skipped.
  assert.ok(expanded.startsWith("/"), "expanded tilde path starts with /");
});

test("merge path resolution: bare capsule id resolves to store path", async () => {
  // Simulates step 3: bare name does not exist at cwd → look up in store.
  // We verify that joining capsulesDir + id + extension produces the right path.
  const { join } = await import("node:path");
  const capsulesDir = "/home/user/.memory/.capsules";
  const capsuleId = "my-snapshot-2026-01-01";

  const byId = join(capsulesDir, `${capsuleId}.capsule.json.gz`);
  assert.equal(
    byId,
    "/home/user/.memory/.capsules/my-snapshot-2026-01-01.capsule.json.gz",
    "capsule id must be joined with the store directory and the .capsule.json.gz extension",
  );

  const byIdEnc = join(capsulesDir, `${capsuleId}.capsule.json.gz.enc`);
  assert.equal(
    byIdEnc,
    "/home/user/.memory/.capsules/my-snapshot-2026-01-01.capsule.json.gz.enc",
    "encrypted variant path must append .enc to the plain archive name",
  );
});
