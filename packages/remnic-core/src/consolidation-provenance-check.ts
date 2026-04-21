/**
 * Consolidation provenance integrity check (issue #561 PR 4).
 *
 * Validates that every memory carrying consolidation provenance frontmatter
 * (`derived_from`, `derived_via`) resolves to real data:
 *
 *   - Each `derived_from` entry `"<path>:<version>"` must name a
 *     page-version snapshot that exists on disk (via the sidecar layout
 *     documented in `page-versioning.ts`).
 *   - Each `derived_via` must be one of the known
 *     `ConsolidationOperator` values — malformed values are surfaced as
 *     warnings rather than crashes so legacy or future operators survive a
 *     rollback.
 *
 * Non-fatal: every failure renders a warning with the offending file path
 * and a human-readable reason.  Integrity problems are informational for
 * now — we do not auto-heal or archive broken memories.
 */

import path from "node:path";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { StorageManager } from "./storage.js";
import { isConsolidationOperator } from "./consolidation-operator.js";

/**
 * One integrity warning attached to a specific memory.
 */
export interface ConsolidationProvenanceIssue {
  /** Absolute path to the memory markdown file. */
  memoryPath: string;
  /** Memory id from frontmatter. */
  memoryId: string;
  /** Type of integrity issue. */
  kind:
    | "derived_from_missing_snapshot"
    | "derived_from_malformed_entry"
    | "derived_via_unknown_operator";
  /** Human-readable detail — includes the offending value when relevant. */
  detail: string;
}

/**
 * Summary of a provenance-integrity scan.  Used by the operator-doctor
 * report and surfaced in the CLI output.
 */
export interface ConsolidationProvenanceReport {
  /** Total memories inspected. */
  scanned: number;
  /** Memories that carry `derived_from` and/or `derived_via`. */
  withProvenance: number;
  /** One entry per problem detected (may be empty). */
  issues: ConsolidationProvenanceIssue[];
}

const DERIVED_FROM_ENTRY_RE = /^(.+):(\d+)$/;

function sidecarKey(pageRelPath: string): string {
  const withoutExt = pageRelPath.replace(/\.md$/i, "");
  return withoutExt.replace(/[\\/]/g, "__");
}

/**
 * Build the on-disk snapshot path for a `"<relpath>:<version>"` entry,
 * relative to the given memory directory.  Mirrors the layout documented
 * in `page-versioning.ts`:
 *
 *   memoryDir/<sidecarDir>/<sidecarKey>/<version><ext>
 */
function resolveSnapshotPath(
  memoryDir: string,
  sidecarDir: string,
  entry: string,
): { ok: true; snapshotPath: string } | { ok: false; reason: string } {
  const match = entry.match(DERIVED_FROM_ENTRY_RE);
  if (!match) {
    return { ok: false, reason: `malformed entry (expected "<path>:<version>")` };
  }
  const pagePath = match[1];
  const versionId = match[2];
  const ext = path.extname(pagePath) || ".md";
  const key = sidecarKey(pagePath);
  const snapshotPath = path.join(memoryDir, sidecarDir, key, `${versionId}${ext}`);
  return { ok: true, snapshotPath };
}

/**
 * Scan every memory under `storage` and flag consolidation-provenance
 * problems.  Does not throw on individual failures — collects them in the
 * returned report.
 */
export async function runConsolidationProvenanceCheck(options: {
  storage: StorageManager;
  memoryDir: string;
  /**
   * Page-versioning sidecar directory name.  Defaults to `.versions` —
   * matches the baked-in default used by `setVersioningConfig` when
   * versioning is enabled via config.
   */
  sidecarDir?: string;
}): Promise<ConsolidationProvenanceReport> {
  const { storage, memoryDir } = options;
  const sidecarDir = options.sidecarDir ?? ".versions";

  const report: ConsolidationProvenanceReport = {
    scanned: 0,
    withProvenance: 0,
    issues: [],
  };

  let memories;
  try {
    memories = await storage.readAllMemories();
  } catch {
    // If we can't enumerate memories at all, surface a single synthetic
    // issue rather than throwing — the doctor wrapper treats an empty
    // issues list as "ok" and we don't want a filesystem hiccup to crash
    // the whole diagnostic.
    return {
      scanned: 0,
      withProvenance: 0,
      issues: [
        {
          memoryPath: memoryDir,
          memoryId: "(unreadable)",
          kind: "derived_from_malformed_entry",
          detail: "Could not enumerate memory directory to scan provenance.",
        },
      ],
    };
  }

  for (const memory of memories) {
    report.scanned += 1;
    const fm = memory.frontmatter;
    const derivedFrom = fm.derived_from;
    const derivedVia = fm.derived_via;

    const hasFrom = Array.isArray(derivedFrom) && derivedFrom.length > 0;
    const hasVia = derivedVia !== undefined && derivedVia !== null;
    if (!hasFrom && !hasVia) continue;
    report.withProvenance += 1;

    if (hasFrom) {
      for (const entry of derivedFrom!) {
        const resolved = resolveSnapshotPath(memoryDir, sidecarDir, entry);
        if (!resolved.ok) {
          report.issues.push({
            memoryPath: memory.path,
            memoryId: fm.id,
            kind: "derived_from_malformed_entry",
            detail: `${JSON.stringify(entry)}: ${resolved.reason}`,
          });
          continue;
        }
        try {
          await access(resolved.snapshotPath, fsConstants.F_OK);
        } catch {
          report.issues.push({
            memoryPath: memory.path,
            memoryId: fm.id,
            kind: "derived_from_missing_snapshot",
            detail: `${entry} → ${resolved.snapshotPath} (not found)`,
          });
        }
      }
    }

    if (hasVia && !isConsolidationOperator(derivedVia)) {
      report.issues.push({
        memoryPath: memory.path,
        memoryId: fm.id,
        kind: "derived_via_unknown_operator",
        detail: `unknown operator: ${JSON.stringify(derivedVia)}`,
      });
    }
  }

  return report;
}
