/**
 * Capsule fork semantics — issue #676 PR 4/6.
 *
 * A fork takes an existing capsule archive, imports it into a target memory
 * root under the `fork` conflict-resolution mode (which rebases all records
 * under `forks/<capsule-id>/`), and then writes a lineage breadcrumb at
 * `<targetRoot>/forks/<forkId>/lineage.json` recording the parent capsule's
 * identity.  Subsequent forks of the same parent or of a fork produce a
 * queryable chain.
 *
 * The lineage breadcrumb is a pure JSON file — no gzip, no bundle format —
 * so downstream tooling can read it with a single `readFile` + `JSON.parse`
 * without pulling in the transfer pipeline.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { importCapsule, type ImportCapsuleResult } from "./capsule-import.js";
import type { CapsuleParent, ExportManifestV2 } from "./types.js";
import { CAPSULE_ID_PATTERN } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link forkCapsule}.
 *
 * `sourceArchive` — absolute or cwd-relative path to a `.capsule.json.gz`
 * archive produced by `exportCapsule`.
 *
 * `targetRoot` — absolute or cwd-relative path to the memory directory that
 * will receive the forked records. Must be an existing directory.
 *
 * `forkId` — user-chosen id for the fork.  Validated against
 * {@link CAPSULE_ID_PATTERN}; must be unique under `<targetRoot>/forks/` (a
 * pre-existing `forks/<forkId>/` directory is rejected before any write).
 *
 * `versioning` — optional page-versioning config forwarded to
 * {@link importCapsule}. Only relevant when the target root already has files
 * that would be overwritten (fork mode is skip-on-exist by design, so this is
 * a no-op unless mode is changed in a future subclass).
 *
 * `now` — optional clock override (ms epoch) forwarded to `importCapsule` for
 * deterministic fork-id rewriting in tests.
 */
export interface ForkCapsuleOptions {
  sourceArchive: string;
  targetRoot: string;
  forkId: string;
  now?: number;
}

/**
 * The lineage breadcrumb written to `forks/<forkId>/lineage.json`.
 *
 * Fields are intentionally flat so the file is human-readable at a glance
 * and trivially diffable by `git diff`.
 *
 * `forkId`          — the id supplied to `forkCapsule`.
 * `forkedAt`        — ISO-8601 creation timestamp (UTC).
 * `parent`          — structured linkage to the source capsule.
 * `importedRecords` — number of records written by the fork import.
 * `skippedRecords`  — number of records skipped (target already existed).
 */
export interface ForkLineage {
  forkId: string;
  forkedAt: string;
  parent: CapsuleParent;
  importedRecords: number;
  skippedRecords: number;
}

export interface ForkCapsuleResult {
  /** Absolute path to the source archive (unchanged, for chaining). */
  archivePath: string;
  /** The V2 manifest decoded from the source archive. */
  manifest: ExportManifestV2;
  /** Result of the underlying `importCapsule` call. */
  importResult: ImportCapsuleResult;
  /** The lineage breadcrumb that was written. */
  lineage: ForkLineage;
  /** Absolute path to the lineage breadcrumb file. */
  lineagePath: string;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Fork a capsule archive into a target memory root.
 *
 * Sequence:
 *   1. Validate `forkId` against {@link CAPSULE_ID_PATTERN}.
 *   2. Resolve `targetRoot` and verify it is an existing directory (not a
 *      symlink — mirrors {@link importCapsule}'s root validation).
 *   3. Reject if `forks/<forkId>/` already exists in the target root
 *      (gotcha #49: deduplicate batch inputs; gotcha #25: don't destroy
 *      old state).
 *   4. Import the archive in `"fork"` mode via {@link importCapsule}.
 *   5. Write the lineage breadcrumb at `forks/<forkId>/lineage.json`.
 *      The breadcrumb dir is created by step 4 (importCapsule writes records
 *      under `forks/<sourceId>/`); if `forkId !== sourceId` we may need to
 *      create the fork dir ourselves. We always `mkdir -p` defensively.
 *
 * Error semantics:
 *   - All validation errors throw before any filesystem write (fail-closed,
 *     gotcha #25).
 *   - If `importCapsule` throws after writing some records, the lineage
 *     breadcrumb is NOT written (partial state is better than a false
 *     "fork complete" marker — gotcha #12: write rollback data before
 *     success markers).
 */
export async function forkCapsule(opts: ForkCapsuleOptions): Promise<ForkCapsuleResult> {
  // --- 1. Validate forkId ---
  validateForkId(opts.forkId);

  // --- 2. Validate targetRoot ---
  const rootAbs = path.resolve(opts.targetRoot);
  await assertIsDirectory(rootAbs);

  // --- 3. Reject duplicate forkId ---
  const forkDirAbs = path.join(rootAbs, "forks", opts.forkId);
  const forkDirExists = await directoryExists(forkDirAbs);
  if (forkDirExists) {
    throw new Error(
      `forkCapsule: fork directory already exists — forkId "${opts.forkId}" is already in use at: ${forkDirAbs}`,
    );
  }

  // --- 4. Import in fork mode ---
  const archiveAbs = path.resolve(opts.sourceArchive);
  const importResult = await importCapsule({
    archivePath: archiveAbs,
    root: rootAbs,
    mode: "fork",
    now: opts.now,
  });

  const manifest = importResult.manifest;
  const sourceCapsule = manifest.capsule;

  // --- 5. Build lineage and write breadcrumb ---
  // The breadcrumb lives under the FORK's own directory, not the source
  // capsule's fork subtree. `forkId` may differ from `sourceCapsule.id`
  // (e.g. `forkCapsule({ forkId: "my-fork" })` with source `base-caps`
  // imports records under `forks/base-caps/` but the lineage breadcrumb
  // is written to `forks/my-fork/lineage.json` so a subsequent fork of
  // this fork can locate the breadcrumb by its own id).
  const forkedAt = new Date(opts.now ?? Date.now()).toISOString();

  const parent: CapsuleParent = {
    capsuleId: sourceCapsule.id,
    version: sourceCapsule.version,
    forkRoot: `forks/${sourceCapsule.id}`,
  };

  const lineage: ForkLineage = {
    forkId: opts.forkId,
    forkedAt,
    parent,
    importedRecords: importResult.imported.length,
    skippedRecords: importResult.skipped.length,
  };

  // Ensure the fork breadcrumb directory exists (it may not exist if forkId
  // differs from the source capsule's id, or if all records were skipped).
  await mkdir(path.dirname(path.join(forkDirAbs, "lineage.json")), { recursive: true });
  const lineagePath = path.join(forkDirAbs, "lineage.json");

  // Write breadcrumb AFTER import completes successfully — consistent with
  // gotcha #25 (don't destroy old state before new state is confirmed) and
  // gotcha #54 (write temp before rename / write before marker).
  await writeFile(lineagePath, JSON.stringify(lineage, null, 2) + "\n", "utf-8");

  return {
    archivePath: archiveAbs,
    manifest,
    importResult,
    lineage,
    lineagePath,
  };
}

// ---------------------------------------------------------------------------
// Lineage query helper
// ---------------------------------------------------------------------------

/**
 * Read the lineage breadcrumb for a given fork in a memory root.
 *
 * Returns `null` when no breadcrumb exists (the directory is not a fork, or
 * was created before PR 4/6). Never throws for a missing file — callers
 * that need to distinguish "not a fork" from "corrupt breadcrumb" should
 * handle the JSON parse error themselves.
 */
export async function readForkLineage(
  targetRoot: string,
  forkId: string,
): Promise<ForkLineage | null> {
  const lineagePath = path.join(path.resolve(targetRoot), "forks", forkId, "lineage.json");
  const raw = await readFile(lineagePath, "utf-8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    // Basic shape check — we do not run full zod validation here so that
    // slightly malformed breadcrumbs (e.g. missing new fields added in later
    // PRs) can still be returned rather than silently dropped.
    if (typeof parsed !== "object" || parsed === null || typeof parsed.forkId !== "string") {
      return null;
    }
    return parsed as ForkLineage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function validateForkId(forkId: unknown): void {
  if (typeof forkId !== "string") {
    throw new Error("forkCapsule: forkId must be a string");
  }
  if (forkId.length === 0) {
    throw new Error("forkCapsule: forkId must not be empty");
  }
  if (forkId.length > 64) {
    throw new Error("forkCapsule: forkId must be 64 characters or fewer");
  }
  if (!CAPSULE_ID_PATTERN.test(forkId)) {
    throw new Error(
      `forkCapsule: invalid forkId "${forkId}". Expected alphanumeric with single dashes (no leading/trailing dashes, no consecutive dashes).`,
    );
  }
}

async function assertIsDirectory(absPath: string): Promise<void> {
  const st = await stat(absPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(`forkCapsule: 'targetRoot' must be an existing directory: ${absPath}`);
  }
}

async function directoryExists(absPath: string): Promise<boolean> {
  const st = await stat(absPath).catch(() => null);
  return st !== null && st.isDirectory();
}
