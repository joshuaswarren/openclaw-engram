/**
 * Diff-aware review-context packer (issue #569 PR 4).
 *
 * When an agent is asked "review this PR" / "what changed in this diff" /
 * "look at this diff", the prompt that reaches recall is short and generic
 * — the real signal is the diff itself. This module:
 *
 *   1. Detects review-intent prompts via `isReviewPrompt`.
 *   2. Extracts the touched file list from a unified diff via
 *      `parseTouchedFiles`.
 *   3. Re-ranks a set of candidate memories so that memories whose
 *      `entityRefs` mention a touched path float to the top. The boost is
 *      additive and bounded so it doesn't obliterate the original ranking —
 *      it's a bias, not a filter.
 *
 * Pure — no orchestrator, no storage. Callers inject the candidate memories
 * they already have from their normal recall pipeline. This keeps the
 * module easy to test and integrates cleanly with the existing tiered-recall
 * code in `orchestrator.ts` (the tier itself can be wired later; the pure
 * surface is what PRs 5/6/7 will call).
 */

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

/**
 * A memory candidate as fed into review-context ranking. The shape is a
 * deliberate subset of the core `MemorySummary` / recall result — only the
 * fields we actually need — so this module stays decoupled from the rest of
 * the codebase and can be reused by CLI tools, bench fixtures, etc.
 */
export interface ReviewCandidate {
  /** Opaque identifier. Echoed unchanged in the output. */
  id: string;
  /**
   * Pre-review relevance score from the upstream recall pipeline. Higher is
   * better. `0` is treated as "no prior signal" and gets the full review
   * boost when a path match is found.
   */
  score: number;
  /**
   * References the memory mentions (file paths, entity names, etc.). Used
   * to decide whether any touched file appears in the memory's scope.
   *
   * Accepts `undefined`/missing so callers can pass sparse records from
   * legacy storage without pre-filling.
   */
  entityRefs?: string[];
}

export interface ReviewContext {
  /**
   * Normalized file paths touched by the diff. Each entry is forward-slashed
   * and relative to the repo root when possible.
   */
  touchedFiles: string[];
  /**
   * Candidates re-sorted so memories whose `entityRefs` mention a touched
   * path are boosted. Shape matches the input `ReviewCandidate[]` — the
   * boost is recorded on each entry as `boost` for observability.
   */
  rankedRecall: Array<ReviewCandidate & { boost: number }>;
}

// ──────────────────────────────────────────────────────────────────────────
// Review-prompt heuristic
// ──────────────────────────────────────────────────────────────────────────

/**
 * Keyword list from the #569 design doc, plus obvious paraphrases. All
 * matching is case-insensitive and whole-word (so `reviewer` doesn't trigger
 * on `review` alone).
 */
const REVIEW_KEYWORD_PATTERNS: RegExp[] = [
  /\breview\b/i,
  /\bdiff\b/i,
  /\bwhat changed\b/i,
  /\blook at this pr\b/i,
  /\bwhat('?s|\s+is)\s+in\s+this\s+(pr|patch|diff|change)\b/i,
  /\bcode review\b/i,
];

/**
 * `true` when the prompt looks like a review / diff-explanation request.
 *
 * Empty / non-string input → `false` (the caller shouldn't branch on an
 * invalid prompt).
 */
export function isReviewPrompt(prompt: string | null | undefined): boolean {
  if (typeof prompt !== "string") return false;
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  return REVIEW_KEYWORD_PATTERNS.some((re) => re.test(trimmed));
}

// ──────────────────────────────────────────────────────────────────────────
// Unified-diff parser — extract touched files
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse a unified diff and return the set of files touched. Accepts both the
 * `diff --git` form (`diff --git a/foo b/bar`) and the `--- / +++` form
 * (`--- a/foo\n+++ b/bar`). Returns deduplicated, repo-root-relative paths
 * (with the conventional `a/` / `b/` prefixes stripped).
 *
 * Path entries of `/dev/null` (used in adds/deletes) are excluded.
 */
export function parseTouchedFiles(diff: string | null | undefined): string[] {
  if (typeof diff !== "string" || !diff.trim()) return [];
  const touched = new Set<string>();
  const lines = diff.split(/\r?\n/);

  for (const line of lines) {
    // `diff --git a/foo/bar.ts b/foo/bar.ts`
    const gitMatch = /^diff --git\s+(\S+)\s+(\S+)/.exec(line);
    if (gitMatch) {
      for (const raw of [gitMatch[1], gitMatch[2]]) {
        if (!raw) continue;
        const stripped = stripDiffPathPrefix(raw);
        if (stripped && stripped !== "/dev/null") touched.add(stripped);
      }
      continue;
    }
    // `--- a/foo/bar.ts` or `+++ b/foo/bar.ts`
    const headerMatch = /^(?:---|\+\+\+)\s+(\S.*?)\s*$/.exec(line);
    if (headerMatch) {
      const raw = headerMatch[1] ?? "";
      const stripped = stripDiffPathPrefix(raw);
      if (stripped && stripped !== "/dev/null") touched.add(stripped);
    }
  }

  return Array.from(touched).sort();
}

function stripDiffPathPrefix(raw: string): string {
  // Git conventionally prefixes paths with `a/` or `b/` in diffs. Strip it
  // once. Also normalize any Windows-style backslashes.
  let s = raw.replace(/\\/g, "/");
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  // Trim quotes git uses for paths containing whitespace.
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    s = s.slice(1, -1);
  }
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// Ranking
// ──────────────────────────────────────────────────────────────────────────

/**
 * Additive boost per matching touched-file. Tuned so that a single exact
 * match is enough to float a `score=0` candidate above a `score=0.4`
 * unmatched peer, but not so large it buries multi-signal results. `0.5`
 * per match, capped at `1.0` so three matches don't eclipse strong recall.
 */
const BOOST_PER_MATCH = 0.5;
const MAX_BOOST = 1.0;

/**
 * Count how many touched files appear in a memory's entityRefs. Matches are
 * literal substring matches on either direction — either the ref contains
 * the path, or the path contains the ref — so both
 *   - `"src/foo.ts"` refs matching a touched `"src/foo.ts"`, and
 *   - `"foo.ts"` refs matching a touched `"src/foo.ts"`
 * succeed.
 */
function countPathHits(entityRefs: string[] | undefined, touchedFiles: string[]): number {
  if (!entityRefs || entityRefs.length === 0) return 0;
  if (touchedFiles.length === 0) return 0;
  let hits = 0;
  for (const ref of entityRefs) {
    if (typeof ref !== "string" || !ref) continue;
    const lowered = ref.toLowerCase();
    for (const file of touchedFiles) {
      const flower = file.toLowerCase();
      if (lowered === flower) {
        hits += 1;
        break;
      }
      if (lowered.includes(flower) || flower.includes(lowered)) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

/**
 * Build a review-context ranking for a set of candidate memories.
 *
 * Contract:
 *   - `touchedFiles` is the parsed diff file list.
 *   - `candidates` is passed through unchanged when no boost applies.
 *   - When a boost applies, the result is sorted by `(score + boost)` desc,
 *     with a stable secondary sort on the original `id` for determinism
 *     (CLAUDE.md #19 — comparators must return 0 for equal items).
 */
export function rankReviewCandidates(
  candidates: ReviewCandidate[],
  touchedFiles: string[],
): Array<ReviewCandidate & { boost: number }> {
  const annotated: Array<ReviewCandidate & { boost: number }> = candidates.map((c) => {
    const hits = countPathHits(c.entityRefs, touchedFiles);
    const boost = Math.min(MAX_BOOST, hits * BOOST_PER_MATCH);
    return { ...c, boost };
  });

  annotated.sort((a, b) => {
    const adjA = a.score + a.boost;
    const adjB = b.score + b.boost;
    if (adjA !== adjB) return adjB - adjA;
    // Stable secondary sort for deterministic ordering on ties.
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return annotated;
}

// ──────────────────────────────────────────────────────────────────────────
// Packer entry point
// ──────────────────────────────────────────────────────────────────────────

export interface PackReviewContextInput {
  /** Unified diff, as produced by `git diff`. */
  diff: string | null | undefined;
  /** Candidate memories from the upstream recall pipeline. */
  candidates: ReviewCandidate[];
}

/**
 * Top-level entry point used by the orchestrator (and CLI / bench) when a
 * review-intent prompt is detected.
 *
 * Parses the diff, re-ranks the candidates, and returns both artefacts so
 * the caller can surface `touchedFiles` as context and `rankedRecall` as
 * the recall result.
 */
export function packReviewContext(input: PackReviewContextInput): ReviewContext {
  const touchedFiles = parseTouchedFiles(input.diff);
  const rankedRecall = rankReviewCandidates(input.candidates, touchedFiles);
  return { touchedFiles, rankedRecall };
}
