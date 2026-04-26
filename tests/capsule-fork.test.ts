/**
 * Tests for capsule fork semantics — issue #676 PR 4/6.
 *
 * Coverage:
 *  1. fork creates lineage breadcrumb with correct parent metadata
 *  2. fork on existing fork-id is rejected (before any write)
 *  3. lineage chain across two forks (A→B→C) is queryable
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { exportCapsule } from "../packages/remnic-core/src/transfer/capsule-export.js";
import {
  forkCapsule,
  readForkLineage,
  type ForkLineage,
} from "../packages/remnic-core/src/transfer/capsule-fork.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FixtureFile {
  rel: string;
  content: string;
}

async function makeMemoryDir(files: FixtureFile[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "capsule-fork-src-"));
  for (const f of files) {
    const abs = path.join(root, ...f.rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf-8");
  }
  return root;
}

async function makeEmptyDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "capsule-fork-dst-"));
}

/** Export a set of files as a named capsule archive and return the archivePath. */
async function exportFixture(
  files: FixtureFile[],
  name: string,
  capsuleVersion?: string,
): Promise<{ archivePath: string; sourceRoot: string }> {
  const sourceRoot = await makeMemoryDir(files);
  const result = await exportCapsule({
    name,
    root: sourceRoot,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: capsuleVersion ? { version: capsuleVersion } : undefined,
  });
  return { archivePath: result.archivePath, sourceRoot };
}

async function listAll(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  async function walk(d: string, prefix: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  }
  await walk(dir, "");
  return out.sort();
}

// ---------------------------------------------------------------------------
// Test 1: fork creates lineage breadcrumb with correct parent metadata
// ---------------------------------------------------------------------------

test("forkCapsule: creates lineage breadcrumb with correct parent metadata", async () => {
  const files: FixtureFile[] = [
    { rel: "facts/2026-04-25/fact-a.md", content: "---\nid: fact-a\n---\n\nbody-a\n" },
    { rel: "entities/acme.md", content: "# Acme\n" },
  ];

  const { archivePath } = await exportFixture(files, "parent-capsule", "1.2.0");
  const targetRoot = await makeEmptyDir();

  const result = await forkCapsule({
    sourceArchive: archivePath,
    targetRoot,
    forkId: "my-fork",
    now: 42,
  });

  // --- lineage shape ---
  const { lineage, lineagePath } = result;
  assert.equal(lineage.forkId, "my-fork");
  assert.equal(lineage.parent.capsuleId, "parent-capsule");
  assert.equal(lineage.parent.version, "1.2.0");
  assert.equal(lineage.parent.forkRoot, "forks/parent-capsule");
  assert.equal(lineage.importedRecords, 2);
  assert.equal(lineage.skippedRecords, 0);
  // forkedAt is an ISO-8601 string
  assert.match(lineage.forkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // --- breadcrumb file exists and is valid JSON ---
  const raw = await readFile(lineagePath, "utf-8");
  const parsed: ForkLineage = JSON.parse(raw);
  assert.equal(parsed.forkId, "my-fork");
  assert.equal(parsed.parent.capsuleId, "parent-capsule");
  assert.equal(parsed.parent.version, "1.2.0");

  // --- lineagePath is inside forks/<forkId>/ ---
  const rel = path.relative(targetRoot, lineagePath);
  assert.equal(rel, path.join("forks", "my-fork", "lineage.json"));

  // --- imported records land under forks/<capsuleId>/ ---
  const allFiles = await listAll(targetRoot);
  assert.ok(
    allFiles.some((f) => f.startsWith("forks/parent-capsule/facts/")),
    "imported records should be under forks/parent-capsule/",
  );
  assert.ok(
    allFiles.includes("forks/my-fork/lineage.json"),
    "lineage breadcrumb should be at forks/my-fork/lineage.json",
  );
});

// ---------------------------------------------------------------------------
// Test 2: fork-on-existing-fork-id is rejected
// ---------------------------------------------------------------------------

test("forkCapsule: rejects duplicate forkId before any write", async () => {
  const files: FixtureFile[] = [
    { rel: "facts/a.md", content: "---\nid: a\n---\n\nbody\n" },
  ];

  const { archivePath } = await exportFixture(files, "source-cap");
  const targetRoot = await makeEmptyDir();

  // First fork succeeds.
  await forkCapsule({
    sourceArchive: archivePath,
    targetRoot,
    forkId: "dup-fork",
    now: 1,
  });

  // Second fork with the same forkId must throw BEFORE writing.
  await assert.rejects(
    () => forkCapsule({ sourceArchive: archivePath, targetRoot, forkId: "dup-fork", now: 2 }),
    (err: Error) => {
      assert.ok(
        err.message.includes("dup-fork") && err.message.includes("already in use"),
        `Expected "already in use" error, got: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 3: lineage chain across two forks (A→B→C) is queryable
// ---------------------------------------------------------------------------

test("forkCapsule: lineage chain A→B→C is queryable via readForkLineage", async () => {
  // Capsule A (the root archive)
  const filesA: FixtureFile[] = [
    { rel: "facts/a.md", content: "---\nid: a\n---\n\nroot fact\n" },
  ];
  const { archivePath: archiveA } = await exportFixture(filesA, "capsule-a", "1.0.0");

  // Fork A → B: import A into targetB as fork "fork-b"
  const targetB = await makeEmptyDir();
  const forkBResult = await forkCapsule({
    sourceArchive: archiveA,
    targetRoot: targetB,
    forkId: "fork-b",
    now: 100,
  });

  // Verify B's lineage points to A.
  const lineageB = await readForkLineage(targetB, "fork-b");
  assert.ok(lineageB !== null, "lineage for fork-b must exist");
  assert.equal(lineageB!.forkId, "fork-b");
  assert.equal(lineageB!.parent.capsuleId, "capsule-a");
  assert.equal(lineageB!.parent.version, "1.0.0");
  assert.equal(lineageB!.parent.forkRoot, "forks/capsule-a");

  // Now export B's fork tree as capsule-b so we can fork it again.
  // We export from targetB (which now contains forks/capsule-a/ and forks/fork-b/).
  const exportBResult = await exportCapsule({
    name: "capsule-b",
    root: targetB,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: {
      version: "2.0.0",
      parent: {
        capsuleId: "capsule-a",
        version: "1.0.0",
        forkRoot: "forks/capsule-a",
      },
      parentCapsule: "capsule-a",
    },
  });

  // Fork B → C: import capsule-b archive into targetC as fork "fork-c"
  const targetC = await makeEmptyDir();
  await forkCapsule({
    sourceArchive: exportBResult.archivePath,
    targetRoot: targetC,
    forkId: "fork-c",
    now: 200,
  });

  // Verify C's lineage points to B.
  const lineageC = await readForkLineage(targetC, "fork-c");
  assert.ok(lineageC !== null, "lineage for fork-c must exist");
  assert.equal(lineageC!.forkId, "fork-c");
  assert.equal(lineageC!.parent.capsuleId, "capsule-b");
  assert.equal(lineageC!.parent.version, "2.0.0");
  assert.equal(lineageC!.parent.forkRoot, "forks/capsule-b");

  // The full chain is: A ← B (lineage in targetB) ← C (lineage in targetC).
  // We can reconstruct the chain by reading lineages:
  //   lineageC.parent.capsuleId === "capsule-b" (which we know is a fork of "capsule-a")
  //   lineageB.parent.capsuleId === "capsule-a"
  assert.equal(lineageC!.parent.capsuleId, "capsule-b");
  assert.equal(lineageB!.parent.capsuleId, "capsule-a");
});

// ---------------------------------------------------------------------------
// Test 4: forkId validation rejects invalid ids
// ---------------------------------------------------------------------------

test("forkCapsule: rejects invalid forkId values", async () => {
  const files: FixtureFile[] = [
    { rel: "facts/a.md", content: "---\nid: a\n---\nbody\n" },
  ];
  const { archivePath } = await exportFixture(files, "validate-cap");
  const targetRoot = await makeEmptyDir();

  const invalid = [
    "",            // empty
    "-leading",    // leading dash
    "trailing-",   // trailing dash
    "a--b",        // consecutive dashes
    "has space",   // space
    "A".repeat(65), // too long
  ];

  for (const id of invalid) {
    await assert.rejects(
      () => forkCapsule({ sourceArchive: archivePath, targetRoot, forkId: id }),
      (err: Error) => {
        assert.ok(err instanceof Error, "must throw an Error");
        return true;
      },
      `forkId "${id}" should be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 5: readForkLineage returns null for non-existent fork
// ---------------------------------------------------------------------------

test("readForkLineage: returns null when breadcrumb does not exist", async () => {
  const dir = await makeEmptyDir();
  const result = await readForkLineage(dir, "nonexistent-fork");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Test 6: CapsuleBlock parent field is set in export and survives round-trip
// ---------------------------------------------------------------------------

test("exportCapsule: parent field survives JSON round-trip", async () => {
  const files: FixtureFile[] = [
    { rel: "facts/a.md", content: "body\n" },
  ];
  const sourceRoot = await makeMemoryDir(files);
  const result = await exportCapsule({
    name: "fork-with-parent",
    root: sourceRoot,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
    capsule: {
      parent: {
        capsuleId: "upstream-cap",
        version: "3.0.0",
        forkRoot: "forks/upstream-cap",
      },
      parentCapsule: "upstream-cap",
    },
  });

  // Re-read manifest from sidecar.
  const manifestRaw = await readFile(
    path.join(path.dirname(result.archivePath), "fork-with-parent.manifest.json"),
    "utf-8",
  );
  const manifest = JSON.parse(manifestRaw);

  assert.ok(manifest.capsule.parent !== null, "parent should not be null");
  assert.equal(manifest.capsule.parent.capsuleId, "upstream-cap");
  assert.equal(manifest.capsule.parent.version, "3.0.0");
  assert.equal(manifest.capsule.parent.forkRoot, "forks/upstream-cap");
  assert.equal(manifest.capsule.parentCapsule, "upstream-cap");
});
