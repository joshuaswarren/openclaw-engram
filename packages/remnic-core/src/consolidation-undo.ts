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
import { mkdir, writeFile, access } from "node:fs/promises";
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
    try {
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, snapshotContent, "utf-8");
      result.restores.push({ entry, sourcePath, outcome: "restored" });
    } catch (err) {
      result.restores.push({
        entry,
        sourcePath,
        outcome: "skipped_snapshot_missing",
        detail: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (dryRun) {
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
  if (result.error) {
    lines.push(`  ERROR: ${result.error}`);
    return lines.join("\n");
  }
  for (const r of result.restores) {
    lines.push(`  - ${r.entry} → ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
  }
  lines.push(
    result.dryRun
      ? "  (dry run — no files were modified, target not archived)"
      : `  target archived: ${result.targetArchived ? "yes" : "no"}`,
  );
  return lines.join("\n");
}
