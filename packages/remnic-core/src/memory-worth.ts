/**
 * Issue #560 PR 2 — Memory Worth scoring (pure helper).
 *
 * Given per-memory outcome counters (`mw_success`, `mw_fail` — added to
 * frontmatter in PR 1), compute a scalar worth score plus interpretable
 * metadata. The score is a Laplace-smoothed success probability with an
 * optional recency decay, and is meant to be used as a multiplier on existing
 * recall scores (PR 4) to sink memories that consistently lead to failed
 * sessions and keep uninstrumented memories at a neutral baseline.
 *
 * Intentional properties:
 *   - Pure function. No I/O, no time-of-import side effects. Testable in
 *     isolation; callers pass `now` so tests don't depend on the wall clock.
 *   - Laplace-smoothed ratio `(s + 1) / (s + f + 2)` ensures a memory with
 *     zero observations scores exactly 0.5 — neither boosted nor penalized.
 *     A single failure on a new memory lands at 1/3, not 0, so one bad
 *     session doesn't permanently exile a fact.
 *   - Recency decay is optional. When a memory hasn't been touched in a long
 *     time, its `p_success` is pulled back toward 0.5 (the prior). Decay is
 *     exponential with an operator-configured half-life so old verdicts
 *     aren't treated as equally informative as fresh ones.
 *   - Corrupt / missing inputs fail safely to the prior. Callers upstream of
 *     this helper (see `storage.parseMemoryWorthCounterField` in PR 1) already
 *     strip negatives and non-integers, but the helper re-validates so it
 *     survives being called directly from tests / ad-hoc tooling.
 *   - Confidence is the effective number of observations (post-decay). PR 4
 *     and PR 5 use it to decide whether the Memory Worth multiplier should
 *     actually be applied vs. left at 1.0 (i.e., "not enough signal yet").
 *
 * Out of scope here:
 *   - Mutating frontmatter (PR 3).
 *   - Recall integration / feature flag (PR 4).
 *   - Benchmark & default-flip (PR 5).
 */

/**
 * Input to `computeMemoryWorth`.
 *
 * All fields are optional so a legacy (pre-PR-1) memory can be passed through
 * without upstream guards — it will simply score to the neutral prior.
 */
export interface ComputeMemoryWorthInput {
  /** Count of sessions where this memory was recalled and the outcome was success. */
  mw_success?: number;
  /** Count of sessions where this memory was recalled and the outcome was failure. */
  mw_fail?: number;
  /**
   * ISO timestamp of the most recent outcome observation for this memory.
   * When provided together with `halfLifeMs`, observations decay exponentially
   * toward the uniform prior as they age. Absent / unparseable timestamp →
   * decay is skipped and raw counters are used directly.
   */
  lastAccessed?: string | null;
  /**
   * Current wall-clock reference. Required in the signature (not defaulted to
   * `Date.now()`) so the function stays pure and tests are deterministic.
   */
  now: Date;
  /**
   * Half-life for outcome decay, in milliseconds. When `undefined` or `<= 0`,
   * no decay is applied (raw counts are used). When positive, counter weights
   * are multiplied by `2^(-age / halfLifeMs)`.
   */
  halfLifeMs?: number;
}

/**
 * Output of `computeMemoryWorth`.
 *
 * `score` is the value recall callers multiply into their base score.
 * `p_success` is the same number pre-clamped — exposed separately so
 * observability surfaces can log the probability distinctly from the
 * multiplier. `confidence` is the effective observation count after decay,
 * useful for UIs that want to render "strong signal" vs. "tentative".
 */
export interface MemoryWorthResult {
  /**
   * The Laplace-smoothed success probability, post-decay, clamped to
   * `[0, 1]`. This is the multiplier PR 4 applies to the base recall score.
   */
  score: number;
  /**
   * Same as `score` conceptually, surfaced separately so telemetry /
   * xray surfaces can report probability independently of whatever final
   * multiplier PR 4 chooses to apply.
   */
  p_success: number;
  /**
   * Effective observation count (`s_eff + f_eff`). With decay enabled this is
   * fractional; without decay it equals `mw_success + mw_fail` exactly.
   * Zero indicates no signal — callers should treat the score as a prior.
   */
  confidence: number;
}

/**
 * Treat fractional or negative counter inputs as zero. Upstream writers in
 * PR 1 already reject these, but this helper is also called from tests and
 * benchmark seeders that build inputs by hand, so we defend here too.
 */
function sanitizeCounter(value: number | undefined): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  // Non-integer counters are refused outright (not floored). Fractional
  // counters can only arise from hand-edited frontmatter or a mis-seeded
  // bench fixture — the PR 1 serializer rejects them on write. Treating
  // `1.9` as `1` would give obviously-corrupt data non-zero confidence and
  // shift the score away from the neutral prior. Fail to 0 instead.
  if (!Number.isInteger(value)) return 0;
  return value;
}

/**
 * Parse `lastAccessed` into a millisecond timestamp. Any parse failure
 * collapses to `null`, which disables decay rather than throwing.
 */
function parseLastAccessedMs(lastAccessed: string | null | undefined): number | null {
  if (!lastAccessed) return null;
  const parsed = Date.parse(lastAccessed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * Compute the decay multiplier for an observation of age `ageMs` given a
 * `halfLifeMs`. Returns `1` when decay is disabled or age is non-positive
 * (can happen if a test seeds `lastAccessed` slightly in the future).
 */
function decayFactor(ageMs: number, halfLifeMs: number | undefined): number {
  if (typeof halfLifeMs !== "number") return 1;
  if (!Number.isFinite(halfLifeMs)) return 1;
  if (halfLifeMs <= 0) return 1;
  if (ageMs <= 0) return 1;
  return Math.pow(2, -ageMs / halfLifeMs);
}

/**
 * Score a single memory's worth based on outcome history.
 *
 * Returns the neutral prior (`0.5`, `confidence=0`) for uninstrumented
 * memories so the caller can treat "no data" and "data says 50/50"
 * identically — neither should be penalized.
 */
export function computeMemoryWorth(input: ComputeMemoryWorthInput): MemoryWorthResult {
  const rawS = sanitizeCounter(input.mw_success);
  const rawF = sanitizeCounter(input.mw_fail);

  const lastAccessedMs = parseLastAccessedMs(input.lastAccessed);
  const nowMs = input.now.getTime();
  // An invalid `now` Date (`new Date("bad")`) would otherwise propagate
  // NaN through `ageMs` → `decayFactor` → score and poison any downstream
  // sort that treats NaN as "less than everything". Skip decay in that
  // case — the raw counters are still well-defined.
  const nowUsable = Number.isFinite(nowMs);
  const ageMs =
    !nowUsable || lastAccessedMs === null ? 0 : Math.max(0, nowMs - lastAccessedMs);
  const factor = nowUsable ? decayFactor(ageMs, input.halfLifeMs) : 1;

  const sEff = rawS * factor;
  const fEff = rawF * factor;

  // Laplace smoothing: Beta(1,1) prior ⇒ (s+1) / (s+f+2).
  // This is equivalent to adding one imaginary success + one imaginary
  // failure before computing the ratio, and guarantees a finite non-zero
  // result even when both counters are 0.
  const pSuccess = (sEff + 1) / (sEff + fEff + 2);

  // Clamp defensively — floating-point noise can push (s+1)/(s+f+2) a hair
  // outside [0, 1] when `factor` is very small, and the callers (recall
  // score multiplication) expect a well-formed probability.
  const clamped = Math.max(0, Math.min(1, pSuccess));

  return {
    score: clamped,
    p_success: clamped,
    confidence: sEff + fEff,
  };
}
