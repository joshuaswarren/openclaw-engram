/**
 * consolidation-operator.ts — Standalone operator vocabulary + validators
 * for the consolidation subsystem (issue #561, All-Mem paper
 * arxiv:2603.19595).
 *
 * This module is intentionally dependency-free so storage, the `remnic
 * doctor` check (PR 4), and the undo CLI (PR 5) can import the validators
 * without dragging in the full consolidation engine — which in turn pulls
 * in the Codex materialize runner and creates a `storage → consolidation
 * → codex-materialize-runner → storage` import cycle.
 *
 * The `semantic-consolidation.ts` module re-exports these symbols so
 * existing import paths continue to work.
 */

/**
 * Operator algebra for non-destructive consolidation.
 *
 * - `split`  — one source memory is rewritten as multiple smaller memories.
 * - `merge`  — multiple source memories are collapsed into one canonical
 *   memory.
 * - `update` — a newer value supersedes an older value within the same
 *   logical fact.
 */
export type ConsolidationOperator = "split" | "merge" | "update";

/**
 * Allowed values for the `derived_via` frontmatter field.  Used by storage
 * validation to reject unknown operator values on write.
 */
export const CONSOLIDATION_OPERATORS: readonly ConsolidationOperator[] = [
  "split",
  "merge",
  "update",
] as const;

/**
 * Regular expression for validating a single `derived_from` entry.
 *
 * Format: `<non-empty memory path>:<integer version >= 0>`.  Matches the
 * `path:versionNumber` convention used by `page-versioning.ts` snapshots
 * (e.g. `"facts/preferences.md:3"`).  The path portion is greedy-last so
 * paths that themselves contain a colon remain parseable — only the final
 * `:<digits>` is consumed as the version.
 */
const DERIVED_FROM_ENTRY_RE = /^(.+):(\d+)$/;

/**
 * Validate a `derived_from` entry string.  Returns `true` if the entry
 * parses as `<non-empty path>:<integer >= 0>`.  Kept pure so storage and
 * future CLI/doctor paths can share the same validator.
 */
export function isValidDerivedFromEntry(entry: unknown): entry is string {
  if (typeof entry !== "string") return false;
  const match = entry.match(DERIVED_FROM_ENTRY_RE);
  if (!match) return false;
  const pathPart = match[1];
  if (pathPart.length === 0 || pathPart.trim().length === 0) return false;
  const versionNum = Number(match[2]);
  return Number.isInteger(versionNum) && versionNum >= 0;
}

/**
 * Type guard for `ConsolidationOperator`.
 */
export function isConsolidationOperator(value: unknown): value is ConsolidationOperator {
  return (
    typeof value === "string" &&
    (CONSOLIDATION_OPERATORS as readonly string[]).includes(value)
  );
}
