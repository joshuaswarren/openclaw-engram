/**
 * Consolidation undo (issue #561 PR 5).
 *
 * Reverts a consolidated memory by restoring each source memory from its
 * `derived_from` snapshot and archiving the target.
 *
 * Contract:
 *   - Load the target memory markdown file via its absolute path.
 *   - For every `"<rel>:<version>"` entry in `derived_from`, fetch the
 *     snapshot content via `page-versioning.getVersion` and restore it
 *     to the original relative path.  If the restore target file
 *     already exists, we skip overwriting it (the source was never
 *     archived, or was re-created since) and record the skip.
 *   - Archive the target with reason code `"consolidation-undo"` so the
 *     lifecycle ledger records the undo.
 *   - Dry-run mode produces the same plan without touching disk.
 *
 * The helper is kept pure over `StorageManager` so the CLI can reuse it
 * without additional wiring, and tests can exercise the plan logic
 * directly.
 */

import path from "node:path";
import { mkdir, writeFile, access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { StorageManager } from "./storage.js";
import type { VersioningConfig } from "./page-versioning.js";
import { getVersion } from "./page-versioning.js";

/**
 * Outcome of restoring a single `derived_from` source.
 */
export interface ConsolidationUndoRestore {
  /** The raw `"<relpath>:<version>"` entry from `derived_from`. */
  entry: string;
  /** Absolute path where the source would be / was restored. */
  sourcePath: string;
  /** What actually happened. */
  outcome:
    | "restored"
    | "skipped_file_exists"
    | "skipped_snapshot_missing"
    | "skipped_malformed_entry"
    | "skipped_outside_memory_dir"
    | "skipped_write_failed"
    | "skipped_dry_run";
  /** Human-readable detail. */
  detail?: string;
}

/**
 * Plan + result of a `remnic consolidate undo` invocation.
 */
export interface ConsolidationUndoResult {
  /** Absolute path to the target memory. */
  targetPath: string;
  /** True when the target was archived successfully. */
  targetArchived: boolean;
  /** Per-source restore outcomes. */
  restores: ConsolidationUndoRestore[];
  /** Whether the run was a dry-run plan only. */
  dryRun: boolean;
  /** Fatal error, if any — the run bails early. */
  error?: string;
}

const DERIVED_FROM_ENTRY_RE = /^(.+):(\d+)$/;

function parseEntry(entry: string): { pagePath: string; versionId: string } | null {
  const match = entry.match(DERIVED_FROM_ENTRY_RE);
  if (!match) return null;
  return { pagePath: match[1], versionId: match[2] };
}

/**
 * Verify that `candidate` resolves inside `root` (defense against
 * path-traversal in `derived_from` entries and user-facing target
 * paths).  Path-string normalization only; for symlink-aware checks
 * use `isInsideDirectoryRealpath`.  Both paths are resolved to
 * absolute form before comparison so `..` segments, symlinks-as-
 * strings, and relative prefixes are normalized.
 */
export function isInsideDirectory(candidate: string, root: string): boolean {
  const normRoot = path.resolve(root);
  const normCandidate = path.resolve(candidate);
  const rel = path.relative(normRoot, normCandidate);
  if (rel.length === 0) return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Symlink-aware containment check (PR #637 round-2 review, codex P1).
 *
 * `isInsideDirectory` only normalizes path strings — if a `derived_from`
 * entry resolves through a symlink inside `memoryDir` that points
 * outside, the string check passes but the subsequent `writeFile` would
 * land outside the memory tree.  Use this guard for any path that is
 * about to be written.
 *
 * Walks every parent directory between `candidate` and `root`,
 * `realpath`-ing each segment that exists and rejecting when any
 * segment escapes `root`.  Non-existent parents are resolved as the
 * canonicalized deepest-existing ancestor plus the trailing segments,
 * so a not-yet-created target file still gets the symlink check on its
 * existing parent directories.
 */
export async function isInsideDirectoryRealpath(
  candidate: string,
  root: string,
): Promise<boolean> {
  if (!isInsideDirectory(candidate, root)) return false;
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(path.resolve(root));
  } catch {
    return false;
  }
  // Walk up from the candidate until we hit a path that exists, then
  // realpath THAT and re-apply the trailing segments textually.
  const normCandidate = path.resolve(candidate);
  const parts = normCandidate.split(path.sep);
  for (let i = parts.length; i > 0; i--) {
    const probe = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      const resolved = await realpath(probe);
      // Re-join any trailing segments that didn't exist yet.
      const trailing = parts.slice(i).join(path.sep);
      const final = trailing.length > 0 ? path.join(resolved, trailing) : resolved;
      // Now apply the textual containment check against the canonical
      // `resolvedRoot`.
      const rel = path.relative(resolvedRoot, final);
      if (rel.length === 0) return true;
      if (rel.startsWith("..")) return false;
      if (path.isAbsolute(rel)) return false;
      return true;
    } catch {
      continue;
    }
  }
  // Nothing along the path resolvable — treat as outside by default.
  return false;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Perform a consolidation-undo operation.
 *
 * @param options.storage        Storage manager for the memory directory.
 * @param options.memoryDir      Absolute memory directory root.
 * @param options.targetPath     Absolute path to the consolidated memory.
 * @param options.versioning     Page-versioning config (sidecarDir must
 *                               match the sidecar layout used when the
 *                               snapshots were created).
 * @param options.dryRun         When true, compute the plan but do not
 *                               write or archive.
 */
export async function runConsolidationUndo(options: {
  storage: StorageManager;
  memoryDir: string;
  targetPath: string;
  versioning: VersioningConfig;
  dryRun?: boolean;
}): Promise<ConsolidationUndoResult> {
  const { storage, memoryDir, targetPath, versioning } = options;
  const dryRun = options.dryRun === true;

  const result: ConsolidationUndoResult = {
    targetPath,
    targetArchived: false,
    restores: [],
    dryRun,
  };

  // Defense against path-traversal (PR #637 review, codex P1): refuse
  // to operate on a target outside the configured memory directory.
  // Archive moves and eventual unlink would otherwise let an operator
  // accidentally destroy an unrelated file with memory-like
  // frontmatter.  Uses the realpath-aware check so a symlinked
  // directory inside `memoryDir` can't tunnel a target past the guard.
  if (!(await isInsideDirectoryRealpath(targetPath, memoryDir))) {
    result.error = `target path ${targetPath} is outside memory directory ${memoryDir}`;
    return result;
  }

  // Load the target memory.  readMemoryByPath returns null when the file
  // is absent or unparseable — surface that as a fatal error because the
  // caller cannot continue without a derived_from list.
  const target = await storage.readMemoryByPath(targetPath);
  if (!target) {
    result.error = `could not load target memory at ${targetPath}`;
    return result;
  }

  const derivedFrom = target.frontmatter.derived_from;
  if (!Array.isArray(derivedFrom) || derivedFrom.length === 0) {
    result.error = "target memory has no derived_from entries — nothing to undo";
    return result;
  }

  // Plan every restore.  In dry-run mode we stop before any filesystem
  // mutations; in live mode we still probe for collisions before writing.
  for (const entry of derivedFrom) {
    const parsed = parseEntry(entry);
    if (!parsed) {
      result.restores.push({
        entry,
        sourcePath: "",
        outcome: "skipped_malformed_entry",
        detail: `expected "<path>:<version>" shape`,
      });
      continue;
    }

    const sourcePath = path.join(memoryDir, parsed.pagePath);

    // Defense against crafted `derived_from` entries (PR #637 review,
    // codex P1 r1 + r2): `path.join(memoryDir, "../outside.md")`
    // resolves outside the memory directory, and a symlinked
    // directory within memoryDir that points outside would tunnel the
    // textual check.  Both cases are rejected via the realpath-aware
    // containment guard.
    if (!(await isInsideDirectoryRealpath(sourcePath, memoryDir))) {
      result.restores.push({
        entry,
        sourcePath,
        outcome: "skipped_outside_memory_dir",
        detail: `resolved path escapes memory directory ${memoryDir}`,
      });
      continue;
    }

    // Fetch the snapshot content.  getVersion throws when the snapshot
    // file is missing; translate that to a skip so one missing snapshot
    // doesn't abort the whole undo.
    let snapshotContent: string;
    try {
      snapshotContent = await getVersion(
        sourcePath,
        parsed.versionId,
        versioning,
        memoryDir,
      );
    } catch {
      result.restores.push({
        entry,
        sourcePath,
        outcome: "skipped_snapshot_missing",
        detail: `no snapshot for version ${parsed.versionId}`,
      });
      continue;
    }

    if (await fileExists(sourcePath)) {
      // The source was never archived, or was re-created since the
      // consolidation.  We never overwrite — the operator can inspect
      // the snapshot manually.
      result.restores.push({
        entry,
        sourcePath,
        outcome: "skipped_file_exists",
        detail: "source file already exists; refusing to overwrite",
      });
      continue;
    }

    if (dryRun) {
      result.restores.push({
        entry,
        sourcePath,
        outcome: "skipped_dry_run",
        detail: "would restore from snapshot",
      });
      continue;
    }

    // Live restore: write the snapshot content back to the source path.
    // A disk write failure is distinct from a missing snapshot (PR #637
    // review, cursor Medium) so it gets its own outcome code.
    try {
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, snapshotContent, "utf-8");
      result.restores.push({ entry, sourcePath, outcome: "restored" });
    } catch (err) {
      result.restores.push({
        entry,
        sourcePath,
        outcome: "skipped_write_failed",
        detail: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (dryRun) {
    return result;
  }

  // Archive guard (PR #637 review, cursor High): if we failed to
  // restore ANY source we must NOT archive the target — archiving it
  // would create silent data loss (the consolidated content goes to
  // the archive bucket and nothing replaces it on the active tree).
  // Treat `restored` and `skipped_file_exists` as success because both
  // leave a source file in place; every other outcome means the undo
  // did not recover that source.
  const recoveredCount = result.restores.filter(
    (r) => r.outcome === "restored" || r.outcome === "skipped_file_exists",
  ).length;
  if (recoveredCount === 0) {
    result.error =
      "no sources could be recovered (all snapshots missing or paths unsafe); target not archived to preserve data";
    return result;
  }

  // Archive the target memory.  archiveMemory returns null on failure —
  // we surface that as a non-fatal flag rather than throwing so the
  // already-completed restores still roll forward.
  const archivedAt = await storage.archiveMemory(target, {
    actor: "consolidate-undo",
    reasonCode: "consolidation-undo",
  });
  result.targetArchived = archivedAt !== null;
  return result;
}

/**
 * Render a consolidation-undo result as a human-readable multi-line
 * string for the CLI.  Extracted so tests can snapshot the formatting
 * without parsing stdout.
 */
export function formatConsolidationUndoResult(result: ConsolidationUndoResult): string {
  const lines: string[] = [];
  lines.push(`consolidate undo ${result.dryRun ? "(dry run) " : ""}→ ${result.targetPath}`);
  // Emit per-restore details BEFORE the error (PR #637 review, cursor
  // Medium): the "no sources could be recovered" error is set after
  // the restore loop ran, so operators need the per-source skip
  // reasons to diagnose which snapshots were missing / outside
  // memoryDir / malformed.  Early-bail errors (unloadable target,
  // target outside memoryDir, no derived_from) run before the loop,
  // so `result.restores` is empty in those cases and this block is a
  // no-op.
  for (const r of result.restores) {
    lines.push(`  - ${r.entry} → ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
  }
  if (result.error) {
    lines.push(`  ERROR: ${result.error}`);
    return lines.join("\n");
  }
  lines.push(
    result.dryRun
      ? "  (dry run — no files were modified, target not archived)"
      : `  target archived: ${result.targetArchived ? "yes" : "no"}`,
  );
  return lines.join("\n");
}
