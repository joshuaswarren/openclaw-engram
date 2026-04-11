/**
 * @remnic/core — Write-time semantic dedup guard
 *
 * Complements the exact content-hash check in the orchestrator's write path
 * by detecting near-duplicate candidate facts via embedding cosine similarity.
 *
 * The module intentionally has no dependency on the EmbeddingFallback or QMD
 * classes directly — callers pass in a `lookup` function that returns the
 * top-K nearest neighbors with their cosine scores. This keeps the decision
 * logic pure and trivially testable with synthetic fixtures, and lets the
 * orchestrator reuse whichever backend it already has wired up.
 *
 * Related issue: joshuaswarren/remnic#373
 */

// ── Public types ──────────────────────────────────────────────────────────────

/** A single nearest-neighbor hit from the embedding backend. */
export interface SemanticDedupHit {
  /** Memory id of the existing neighbor. */
  id: string;
  /** Cosine similarity score in [0, 1]. */
  score: number;
  /** Optional source path, purely informational. */
  path?: string;
}

/**
 * Lookup function passed by the caller. Must return an array of hits sorted
 * descending by score. Implementations should return an empty array (never
 * throw) when the embedding backend is unavailable — the decision function
 * treats that as "no near duplicate" (fail-open).
 */
export type SemanticDedupLookup = (
  content: string,
  limit: number,
) => Promise<SemanticDedupHit[]>;

export interface SemanticDedupOptions {
  /** Master switch. When false, `decideSemanticDedup` always returns `keep`. */
  enabled: boolean;
  /** Cosine similarity threshold (0-1). ≥ threshold ⇒ treat as duplicate. */
  threshold: number;
  /** How many nearest neighbors to compare against. */
  candidates: number;
}

export type SemanticDedupDecision =
  | {
      action: "keep";
      reason: "disabled" | "backend_unavailable" | "no_near_duplicate";
      topScore?: number;
      topId?: string;
    }
  | {
      action: "skip";
      reason: "near_duplicate";
      topScore: number;
      topId: string;
      topPath?: string;
    };

// ── Pure decision function ────────────────────────────────────────────────────

/**
 * Pure decision function: given a lookup callback and options, decide whether
 * the candidate content should be written or skipped as a near-duplicate.
 *
 * Contract:
 *   - When `options.enabled` is false → always keep, reason="disabled".
 *   - When the lookup returns 0 hits → keep, reason="backend_unavailable" when
 *     the backend signaled "off" (empty array). We can't distinguish
 *     "genuinely empty index" from "no backend" here, so we collapse both to
 *     the same "keep" outcome.
 *   - When the top hit's score ≥ threshold → skip with reason="near_duplicate".
 *   - Otherwise → keep with reason="no_near_duplicate".
 */
export async function decideSemanticDedup(
  content: string,
  lookup: SemanticDedupLookup,
  options: SemanticDedupOptions,
): Promise<SemanticDedupDecision> {
  if (!options.enabled) {
    return { action: "keep", reason: "disabled" };
  }
  // Zero candidates means the operator has disabled the embedding lookup.
  // Treat it identically to enabled=false so no backend call is made.
  if (options.candidates === 0) {
    return { action: "keep", reason: "disabled" };
  }
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed) {
    return { action: "keep", reason: "no_near_duplicate" };
  }
  const candidates = Math.max(1, Math.floor(options.candidates));
  let hits: SemanticDedupHit[] = [];
  try {
    hits = await lookup(trimmed, candidates);
  } catch {
    // Fail-open: a lookup error must not block writes.
    return { action: "keep", reason: "backend_unavailable" };
  }
  if (!Array.isArray(hits) || hits.length === 0) {
    return { action: "keep", reason: "backend_unavailable" };
  }

  // Defensive: callers ought to return sorted, but don't trust it.
  let top: SemanticDedupHit | undefined;
  for (const hit of hits) {
    if (!hit || typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
      continue;
    }
    if (!top || hit.score > top.score) {
      top = hit;
    }
  }
  if (!top) {
    return { action: "keep", reason: "no_near_duplicate" };
  }

  if (top.score >= options.threshold) {
    return {
      action: "skip",
      reason: "near_duplicate",
      topScore: top.score,
      topId: top.id,
      topPath: top.path,
    };
  }

  return {
    action: "keep",
    reason: "no_near_duplicate",
    topScore: top.score,
    topId: top.id,
  };
}
