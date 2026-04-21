/**
 * Tests for `remnic consolidate undo` (issue #561 PR 5).
 *
 * Covers the pure helper `runConsolidationUndo`:
 *   - Happy path: target has valid `derived_from` entries pointing at
 *     real snapshots, sources have been archived — we restore every
 *     source and archive the target.
 *   - Dry-run: returns the plan without touching disk.
 *   - Skips restore when source file already exists (never overwrite).
 *   - Skips restore when snapshot for a given version is missing.
 *   - Surfaces a fatal error when the target has no `derived_from`.
 *   - Round-trip: semantic-consolidation-style write → undo → source
 *     content matches its pre-consolidation state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import { runConsolidationUndo } from "../src/consolidation-undo.ts";
import type { VersioningConfig } from "../src/page-versioning.ts";

const versioning: VersioningConfig = {
  enabled: true,
  maxVersionsPerPage: 10,
  sidecarDir: ".versions",
};

async function makeStorage(dir: string): Promise<StorageManager> {
  const storage = new StorageManager(dir);
  storage.setVersioningConfig({ ...versioning });
  await storage.ensureDirectories();
  return storage;
}

test("runConsolidationUndo restores sources and archives the target on the happy path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-happy-"));
  try {
    const storage = await makeStorage(dir);

    const srcAId = await storage.writeMemory("fact", "alpha body", { source: "extraction" });
    const srcBId = await storage.writeMemory("fact", "bravo body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const srcA = all.find((m) => m.frontmatter.id === srcAId)!;
    const srcB = all.find((m) => m.frontmatter.id === srcBId)!;

    const entryA = await storage.snapshotForProvenance(srcA.path);
    const entryB = await storage.snapshotForProvenance(srcB.path);
    assert.ok(entryA && entryB);

    // Simulate archival: remove source files so the restore path is
    // the operational case (sources have been archived).
    await unlink(srcA.path);
    await unlink(srcB.path);
    storage.invalidateAllMemoriesCache();

    // Write the canonical memory with provenance fields.
    const canonicalId = await storage.writeMemory("fact", "canonical body", {
      source: "semantic-consolidation",
      derivedFrom: [entryA, entryB],
      derivedVia: "merge",
    });
    const afterWrite = await storage.readAllMemories();
    const canonical = afterWrite.find((m) => m.frontmatter.id === canonicalId)!;

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.dryRun, false);
    assert.equal(result.restores.length, 2);
    for (const r of result.restores) {
      assert.equal(r.outcome, "restored", `expected restored, got ${r.outcome}: ${r.detail}`);
    }
    assert.equal(result.targetArchived, true);

    // Verify the restored files contain the original bodies.
    const restoredA = await readFile(srcA.path, "utf-8");
    const restoredB = await readFile(srcB.path, "utf-8");
    assert.ok(restoredA.includes("alpha body"));
    assert.ok(restoredB.includes("bravo body"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo dry-run produces a plan without writing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-dryrun-"));
  try {
    const storage = await makeStorage(dir);

    const srcId = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);
    await unlink(src.path);
    storage.invalidateAllMemoriesCache();

    const canonicalId = await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((m) => m.frontmatter.id === canonicalId)!;

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_dry_run");
    assert.equal(result.targetArchived, false);

    // Source file still absent (we did not restore).
    await assert.rejects(() => readFile(src.path, "utf-8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo refuses to overwrite existing source files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-collision-"));
  try {
    const storage = await makeStorage(dir);
    const srcId = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);
    // Deliberately leave src.path in place — the undo must not overwrite.
    const canonicalId = await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((m) => m.frontmatter.id === canonicalId)!;

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
    });

    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_file_exists");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo skips sources whose snapshot file has been pruned", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-pruned-"));
  try {
    const storage = await makeStorage(dir);
    const srcId = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);
    await unlink(src.path);

    const canonicalId = await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });
    const after = await storage.readAllMemories();
    const canonical = after.find((m) => m.frontmatter.id === canonicalId)!;

    // Delete the snapshot to simulate pruning.
    const [rel, version] = entry.split(":");
    const sidecarFile = path.join(
      dir,
      ".versions",
      rel.replace(/\.md$/, "").replace(/\//g, "__"),
      `${version}.md`,
    );
    await unlink(sidecarFile);

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: canonical.path,
      versioning,
    });

    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_snapshot_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo surfaces an error when the target has no derived_from", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-no-provenance-"));
  try {
    const storage = await makeStorage(dir);
    const id = await storage.writeMemory("fact", "plain fact", { source: "extraction" });
    const all = await storage.readAllMemories();
    const target = all.find((m) => m.frontmatter.id === id)!;

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath: target.path,
      versioning,
    });
    assert.ok(result.error);
    assert.match(result.error, /derived_from/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationUndo flags malformed derived_from entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-undo-malformed-"));
  try {
    const storage = await makeStorage(dir);

    // Hand-write a memory whose derived_from entry is shaped wrong.  We
    // bypass writeMemory() because its validator would reject the
    // malformed entry — here we specifically want to simulate on-disk
    // corruption that the undo helper must tolerate.
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-malformed";
    const targetPath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T00:00:00.000Z",
      "updated: 2026-04-20T00:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'derived_from: ["facts/ghost.md"]', // no version — invalid shape
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(targetPath, raw, "utf-8");

    const result = await runConsolidationUndo({
      storage,
      memoryDir: dir,
      targetPath,
      versioning,
    });
    // The read-path parser is permissive and preserves the entry
    // verbatim.  The undo helper recognizes the malformed shape and
    // records `skipped_malformed_entry` instead of crashing.  This
    // matches the defense-in-depth contract: hostile on-disk shapes
    // produce graceful skips, never a traceback.
    assert.equal(result.error, undefined);
    assert.equal(result.restores.length, 1);
    assert.equal(result.restores[0].outcome, "skipped_malformed_entry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
