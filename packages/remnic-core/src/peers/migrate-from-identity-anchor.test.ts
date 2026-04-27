/**
 * Tests for the identity-anchor → peer-registry migration.
 *
 * Issue #679 PR 5/5. All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readPeer } from "./storage.js";
import { migrateFromIdentityAnchor } from "./migrate-from-identity-anchor.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "peer-migrate-test-"));
}

/** Write a file, creating intermediate directories as needed. */
async function writeFixture(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixture strings (synthetic, no personal data)
// ──────────────────────────────────────────────────────────────────────────────

const SAMPLE_ANCHOR = `# Identity Continuity Anchor

## Identity Traits

Prefers clear, structured communication.

## Communication Preferences

Bullet points over prose for technical topics.

## Operating Principles

Write tests before implementation.
`;

const SAMPLE_IDENTITY_MD = `## Learning patterns

Tends to iterate on implementation until tests pass cleanly.
`;

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

test("migrate: creates peers/self/identity.md from identity-anchor.md fixture", async () => {
  const dir = await makeTempDir();
  await writeFixture(
    path.join(dir, "identity", "identity-anchor.md"),
    SAMPLE_ANCHOR,
  );

  const result = await migrateFromIdentityAnchor({ memoryDir: dir });

  assert.equal(result.written, true, "expected written=true");
  assert.equal(result.skipped, false);
  assert.equal(result.dryRun, false);
  assert.ok(result.identityAnchorSource !== null, "identityAnchorSource should be set");
  assert.equal(result.peer.id, "self");
  assert.equal(result.peer.kind, "self");

  // Verify the file exists on disk and round-trips through readPeer.
  const loaded = await readPeer(dir, "self");
  assert.ok(loaded !== null, "peers/self/identity.md should exist after migration");
  assert.equal(loaded.id, "self");
  assert.equal(loaded.kind, "self");

  // Notes should contain the anchor content.
  assert.ok(
    loaded.notes?.includes("Identity Traits"),
    "notes should include migrated anchor content",
  );
  assert.ok(
    loaded.notes?.includes("Migrated from identity-anchor.md"),
    "notes should have the section label",
  );
});

test("migrate: includes IDENTITY.md content when both sources present", async () => {
  const dir = await makeTempDir();
  await writeFixture(
    path.join(dir, "identity", "identity-anchor.md"),
    SAMPLE_ANCHOR,
  );
  await writeFixture(path.join(dir, "IDENTITY.md"), SAMPLE_IDENTITY_MD);

  const result = await migrateFromIdentityAnchor({ memoryDir: dir });

  assert.equal(result.written, true);
  assert.ok(result.identityAnchorSource !== null);
  assert.ok(result.identityMdSource !== null, "identityMdSource should be set");

  const loaded = await readPeer(dir, "self");
  assert.ok(loaded !== null);
  assert.ok(loaded.notes?.includes("Migrated from IDENTITY.md"));
  assert.ok(loaded.notes?.includes("Learning patterns"));
});

test("migrate: works with no legacy files (fresh install)", async () => {
  const dir = await makeTempDir();

  const result = await migrateFromIdentityAnchor({ memoryDir: dir });

  assert.equal(result.written, true);
  assert.equal(result.skipped, false);
  assert.equal(result.dryRun, false);
  assert.equal(result.identityAnchorSource, null);
  assert.equal(result.identityMdSource, null);

  const loaded = await readPeer(dir, "self");
  assert.ok(loaded !== null, "self peer should exist even with no source data");
  assert.equal(loaded.id, "self");
  assert.equal(loaded.kind, "self");
  // No notes when both sources are absent.
  assert.equal(loaded.notes, undefined);
});

test("dry-run: prints but does not write", async () => {
  const dir = await makeTempDir();
  await writeFixture(
    path.join(dir, "identity", "identity-anchor.md"),
    SAMPLE_ANCHOR,
  );

  const result = await migrateFromIdentityAnchor({
    memoryDir: dir,
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.written, false);
  assert.equal(result.skipped, false);

  // Proposed peer is returned.
  assert.equal(result.peer.id, "self");
  assert.equal(result.peer.kind, "self");
  assert.ok(result.peer.notes?.includes("Identity Traits"));

  // Nothing should have been written to disk.
  const loaded = await readPeer(dir, "self");
  assert.equal(loaded, null, "no file should exist on disk after dry-run");
});

test("dry-run: returns proposed peer even with no legacy files", async () => {
  const dir = await makeTempDir();

  const result = await migrateFromIdentityAnchor({
    memoryDir: dir,
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.written, false);
  assert.equal(result.skipped, false);
  assert.equal(result.peer.id, "self");
  assert.equal(result.peer.kind, "self");

  const loaded = await readPeer(dir, "self");
  assert.equal(loaded, null, "no file should exist on disk after dry-run");
});

test("idempotent: second run returns skipped=true without overwriting", async () => {
  const dir = await makeTempDir();
  await writeFixture(
    path.join(dir, "identity", "identity-anchor.md"),
    SAMPLE_ANCHOR,
  );

  // First run — writes.
  const first = await migrateFromIdentityAnchor({ memoryDir: dir });
  assert.equal(first.written, true);
  assert.equal(first.skipped, false);

  // Read the createdAt that was assigned.
  const afterFirst = await readPeer(dir, "self");
  assert.ok(afterFirst !== null);
  const createdAt = afterFirst.createdAt;

  // Second run — should skip.
  const second = await migrateFromIdentityAnchor({ memoryDir: dir });
  assert.equal(second.written, false);
  assert.equal(second.skipped, true);
  assert.equal(second.dryRun, false);

  // The on-disk record should be unchanged (same createdAt).
  const afterSecond = await readPeer(dir, "self");
  assert.ok(afterSecond !== null);
  assert.equal(afterSecond.createdAt, createdAt, "createdAt must not change on second run");
});

test("idempotent: running dry-run twice does not write on either run", async () => {
  const dir = await makeTempDir();

  await migrateFromIdentityAnchor({ memoryDir: dir, dryRun: true });
  await migrateFromIdentityAnchor({ memoryDir: dir, dryRun: true });

  const loaded = await readPeer(dir, "self");
  assert.equal(loaded, null, "no file should exist after two dry-runs");
});

test("respects custom displayName option", async () => {
  const dir = await makeTempDir();

  const result = await migrateFromIdentityAnchor({
    memoryDir: dir,
    displayName: "Primary Operator",
  });

  assert.equal(result.peer.displayName, "Primary Operator");
  const loaded = await readPeer(dir, "self");
  assert.ok(loaded !== null);
  assert.equal(loaded.displayName, "Primary Operator");
});

test("symlinked identity-anchor.md is silently skipped", async () => {
  const dir = await makeTempDir();
  // Create the identity directory, then a symlink to a file outside memoryDir.
  const identityDir = path.join(dir, "identity");
  await fs.mkdir(identityDir, { recursive: true });
  const externalFile = path.join(dir, "_external.md");
  await fs.writeFile(externalFile, SAMPLE_ANCHOR, "utf8");
  await fs.symlink(externalFile, path.join(identityDir, "identity-anchor.md"));

  const result = await migrateFromIdentityAnchor({ memoryDir: dir });

  // Symlinked source should be silently skipped.
  assert.equal(result.identityAnchorSource, null);
  // Migration should still succeed (no legacy data, but self peer created).
  assert.equal(result.written, true);
  assert.equal(result.peer.notes, undefined, "no notes from symlinked source");
});

test("symlinked IDENTITY.md is silently skipped", async () => {
  const dir = await makeTempDir();
  const externalFile = path.join(dir, "_external-identity.md");
  await fs.writeFile(externalFile, SAMPLE_IDENTITY_MD, "utf8");
  await fs.symlink(externalFile, path.join(dir, "IDENTITY.md"));

  const result = await migrateFromIdentityAnchor({ memoryDir: dir });

  assert.equal(result.identityMdSource, null);
  assert.equal(result.written, true);
});
