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
 * - `pattern-reinforcement` (issue #687 PR 2/4) — emitted by the
 *   pattern-reinforcement maintenance job when it clusters duplicate
 *   non-procedural memories and promotes the most recent member to
 *   canonical.  Unlike the other operators, the job does not produce
 *   page-versioning snapshots — it just stamps reinforcement metadata
 *   on the canonical and points superseded duplicates at it.  See
 *   `maintenance/pattern-reinforcement.ts`.
 */
export type ConsolidationOperator =
  | "split"
  | "merge"
  | "update"
  | "pattern-reinforcement";

/**
 * Allowed values for the `derived_via` frontmatter field.  Used by storage
 * validation to reject unknown operator values on write.
 */
export const CONSOLIDATION_OPERATORS: readonly ConsolidationOperator[] = [
  "split",
  "merge",
  "update",
  "pattern-reinforcement",
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
 * Regular expression for validating a memory-id `derived_from` entry
 * (issue #687 PR 2/4).  Pattern reinforcement records source memory IDs
 * directly rather than page-versioning snapshots, so we also need to
 * accept that shape.  Memory IDs are alphanumeric with hyphens or
 * underscores — crucially, they MUST NOT contain `:` or `/` so they
 * cannot collide with the `<path>:<version>` form.
 */
const DERIVED_FROM_MEMORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Validate a `derived_from` entry string.  Returns `true` for either
 * - the snapshot format `<non-empty path>:<integer >= 0>` (issue #561), or
 * - a memory-id of the form `<prefix>-<ts>-<suffix>` (issue #687 PR 2/4
 *   — used by pattern-reinforcement provenance).
 *
 * Kept pure so storage and future CLI/doctor paths can share the same
 * validator.
 */
export function isValidDerivedFromEntry(entry: unknown): entry is string {
  if (typeof entry !== "string") return false;
  // Memory-id form takes precedence: it has no `:` so it cannot collide
  // with the `<path>:<version>` form.
  if (DERIVED_FROM_MEMORY_ID_RE.test(entry)) return true;
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
