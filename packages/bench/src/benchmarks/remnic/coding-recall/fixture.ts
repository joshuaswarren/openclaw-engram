/**
 * Fixtures for the coding-agent recall benchmark (issue #569 PR 8).
 *
 * Covers the three invariants PRs 2–4 introduced:
 *
 *   1. Cross-project isolation — a memory written under project A is not
 *      retrievable under project B.
 *   2. Branch isolation — with branchScope enabled, a branch-local memory
 *      on branch A is not retrievable on branch B, but project-level
 *      memories remain visible from any branch.
 *   3. Review-context ranking — on a review-intent prompt, a memory whose
 *      `entityRefs` mention a touched file outranks an unrelated memory of
 *      equal score.
 *
 * All fixtures synthetic — no real repositories, no real user data.
 */

export interface CodingRecallCaseMemory {
  id: string;
  /** Namespace the memory was persisted under. */
  namespace: string;
  /** Optional file-path refs that `review-context` ranking consults. */
  entityRefs?: string[];
  /** Baseline relevance score from the upstream recall pipeline. */
  score: number;
}

export interface CodingRecallCase {
  id: string;
  title: string;
  /** Invariant being exercised — reported in details. */
  kind: "cross-project" | "branch-isolation" | "review-context";
  /** Session's effective read namespaces. The benchmark scorer filters
   *  candidates to these before ranking. */
  sessionNamespaces: string[];
  /** For review-context cases only: touched files parsed from a diff. */
  touchedFiles?: string[];
  /** For review-context cases only: the prompt that triggers the tier. */
  prompt?: string;
  /** All candidate memories in the corpus (multiple projects / branches). */
  candidates: CodingRecallCaseMemory[];
  /** Memories we expect to appear (ordered, highest score first). */
  expectedIds: string[];
  /** Memories that MUST NOT appear — cross-project / cross-branch leaks. */
  forbiddenIds: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Cross-project isolation
// ──────────────────────────────────────────────────────────────────────────

const CROSS_PROJECT_CASE: CodingRecallCase = {
  id: "cross-project-basic",
  title: "Cross-project isolation — project B's memories are invisible to project A",
  kind: "cross-project",
  sessionNamespaces: ["project-origin-aaaaaaaa"],
  candidates: [
    { id: "a1", namespace: "project-origin-aaaaaaaa", score: 0.8, entityRefs: ["src/auth.ts"] },
    { id: "a2", namespace: "project-origin-aaaaaaaa", score: 0.6, entityRefs: ["docs/readme.md"] },
    { id: "b1", namespace: "project-origin-bbbbbbbb", score: 0.9, entityRefs: ["src/auth.ts"] },
    { id: "b2", namespace: "project-origin-bbbbbbbb", score: 0.7, entityRefs: ["docs/readme.md"] },
  ],
  expectedIds: ["a1", "a2"],
  forbiddenIds: ["b1", "b2"],
};

// ──────────────────────────────────────────────────────────────────────────
// Branch isolation with project-level fallback
// ──────────────────────────────────────────────────────────────────────────

const BRANCH_ISOLATION_CASE: CodingRecallCase = {
  id: "branch-isolation-with-project-fallback",
  title:
    "Branch isolation — branch A cannot see branch B, but project-level memories remain visible from branch A",
  kind: "branch-isolation",
  sessionNamespaces: [
    "project-origin-cccccccc-branch-feat-a",
    "project-origin-cccccccc",
  ],
  candidates: [
    // Branch A — should appear
    { id: "brA-local", namespace: "project-origin-cccccccc-branch-feat-a", score: 0.9 },
    // Branch B — must not appear
    { id: "brB-local", namespace: "project-origin-cccccccc-branch-feat-b", score: 0.95 },
    // Project-level — should appear via readFallback
    { id: "proj-level", namespace: "project-origin-cccccccc", score: 0.7 },
    // Other project — must not appear
    { id: "other-proj", namespace: "project-origin-dddddddd", score: 0.85 },
  ],
  expectedIds: ["brA-local", "proj-level"],
  forbiddenIds: ["brB-local", "other-proj"],
};

// ──────────────────────────────────────────────────────────────────────────
// Review-context ranking
// ──────────────────────────────────────────────────────────────────────────

const REVIEW_CONTEXT_CASE: CodingRecallCase = {
  id: "review-context-boosts-touched-files",
  title:
    "Review-context — 'review this diff' boosts memories that reference touched files above equal-score unrelated memories",
  kind: "review-context",
  sessionNamespaces: ["project-origin-eeeeeeee"],
  touchedFiles: ["src/auth.ts"],
  prompt: "review this diff",
  candidates: [
    { id: "touched", namespace: "project-origin-eeeeeeee", score: 0.3, entityRefs: ["src/auth.ts"] },
    { id: "untouched", namespace: "project-origin-eeeeeeee", score: 0.3, entityRefs: ["lib/other.ts"] },
    // A strong unmatched memory — should still appear but not outrank
    // touched (touched has 0.3 + 0.5 = 0.8 ≥ 0.8; stable tie-break wins
    // by id: "strong" < "touched", so "strong" comes first).
    { id: "strong", namespace: "project-origin-eeeeeeee", score: 0.8, entityRefs: ["db.sql"] },
  ],
  // Expected ordering: "strong" (0.8) and "touched" (0.8) tie on adjusted
  // score; stable tie-break by id puts "strong" first. Then "untouched"
  // (0.3) last.
  expectedIds: ["strong", "touched", "untouched"],
  forbiddenIds: [],
};

// ──────────────────────────────────────────────────────────────────────────
// Exported fixtures
// ──────────────────────────────────────────────────────────────────────────

export const CODING_RECALL_FIXTURE: CodingRecallCase[] = [
  CROSS_PROJECT_CASE,
  BRANCH_ISOLATION_CASE,
  REVIEW_CONTEXT_CASE,
];

// Smoke fixture — a single representative case per invariant kind. In this
// benchmark the full fixture is already small, so smoke === full.
export const CODING_RECALL_SMOKE_FIXTURE: CodingRecallCase[] = CODING_RECALL_FIXTURE;
