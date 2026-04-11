/**
 * Maximal Marginal Relevance (MMR) re-selection for recall candidates.
 *
 * After the reranker produces its ordered candidate list, we run an MMR pass
 * over the top N candidates (per-section) so that a cluster of near-duplicate
 * high-scoring facts cannot dominate the injected context.
 *
 *     MMR(d) = λ * sim(d, query) − (1 − λ) * max_{d' ∈ selected} sim(d, d')
 *
 * - λ defaults to 0.7 (tilted toward relevance, with meaningful diversity).
 * - Similarity uses cosine over pre-computed embeddings when available, and
 *   falls back to Jaccard over normalized tokens (lowercased alphanumerics)
 *   when embeddings are missing.
 * - Per-section application is the caller's responsibility: pass each
 *   section's ordered candidate slice independently so one cluster in one
 *   section cannot starve another section.
 *
 * Pure, deterministic, no IO. Input arrays are never mutated.
 */

/** Minimal candidate shape used by MMR. Callers may wrap their own records. */
export interface MmrCandidate {
  /** Stable identifier for the candidate. Only used for tie-breaking. */
  id: string;
  /** Text content used for the Jaccard similarity fallback. */
  content: string;
  /**
   * Relevance score from the upstream ranker (e.g. rerank score or RRF).
   * Used as the `sim(d, query)` term when no query embedding is available.
   */
  score: number;
  /** Optional pre-computed embedding vector for cosine similarity. */
  embedding?: readonly number[] | null;
}

export interface ApplyMmrOptions<C extends MmrCandidate> {
  /** Ordered candidate list (most relevant first). */
  candidates: readonly C[];
  /** Optional query embedding. If provided and candidates carry embeddings,
   *  relevance is measured by cosine similarity to the query. Otherwise
   *  candidate `score` is normalized and used. */
  queryEmbedding?: readonly number[] | null;
  /** λ ∈ [0, 1]. 1 = pure relevance, 0 = pure diversity. Default 0.7. */
  lambda?: number;
  /** Apply MMR only over the top N candidates. Default 40. */
  topN?: number;
  /** Maximum number of candidates to select. Default = candidates length. */
  budget?: number;
}

export interface MmrDiversityReport {
  /** Number of candidates considered after sample-size clamping. */
  considered: number;
  /** Number of candidates kept after MMR. */
  kept: number;
  /** Average pairwise similarity of the head-of-list input slice (pre-MMR). */
  avgPairwiseSimBefore: number;
  /** Average pairwise similarity of the head-of-list MMR output slice. */
  avgPairwiseSimAfter: number;
}

export const DEFAULT_LAMBDA = 0.7;
export const DEFAULT_TOP_N = 40;
/**
 * Default number of head-of-list candidates compared by
 * {@link summarizeMmrDiversity}. Small on purpose: we want to measure whether
 * MMR actually *changed* the head of the list. Comparing the full top-N slice
 * is meaningless when `budget >= candidates.length` because both slices
 * contain the same set (just reordered), making pairwise-similarity
 * order-independent and identical before vs after.
 */
const DEFAULT_DIVERSITY_SAMPLE_SIZE = 10;

/**
 * Pure MMR re-selection over an ordered candidate list.
 *
 * Returns a new array — the input is never mutated. When `candidates.length`
 * is `<= 1` or `budget <= 0`, a defensive copy is returned as a no-op.
 */
export function applyMmrToCandidates<C extends MmrCandidate>(
  opts: ApplyMmrOptions<C>,
): C[] {
  const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
  if (candidates.length === 0) return [];

  const lambda = clampLambda(opts.lambda);
  const topN = clampPositiveInt(opts.topN, DEFAULT_TOP_N);
  const budget = clampPositiveInt(opts.budget, candidates.length);

  if (budget <= 0) return [];
  if (candidates.length === 1) return [candidates[0]!];

  // Only reorder the top-N slice; anything past it keeps its original position
  // appended at the end (but will not be selected unless budget > topN).
  const pool = candidates.slice(0, topN);
  const tail = candidates.slice(topN);

  // Relevance scores as `sim(d, query)`. Prefer cosine to the query embedding
  // when we can compute it; otherwise fall back to the candidate's own score
  // normalized into [0, 1] across the pool.
  const relevance = computeRelevanceScores(pool, opts.queryEmbedding);

  // Pre-compute pairwise candidate-candidate similarity lazily as needed.
  const pairSim = new Map<string, number>();
  const pairKey = (i: number, j: number): string =>
    i < j ? `${i}:${j}` : `${j}:${i}`;
  const sim = (i: number, j: number): number => {
    if (i === j) return 1;
    const key = pairKey(i, j);
    const cached = pairSim.get(key);
    if (cached !== undefined) return cached;
    const a = pool[i]!;
    const b = pool[j]!;
    const s = similarity(a, b);
    pairSim.set(key, s);
    return s;
  };

  const selectedIdx: number[] = [];
  const remaining = new Set<number>();
  for (let i = 0; i < pool.length; i += 1) remaining.add(i);

  while (selectedIdx.length < budget && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (const idx of remaining) {
      const rel = relevance[idx] ?? 0;
      let maxSimToSelected = 0;
      if (selectedIdx.length > 0) {
        for (const s of selectedIdx) {
          const pairwise = sim(idx, s);
          if (pairwise > maxSimToSelected) maxSimToSelected = pairwise;
        }
      }
      const mmr = lambda * rel - (1 - lambda) * maxSimToSelected;
      if (
        mmr > bestMmr ||
        // Stable tie-breaker: prefer the earlier original position.
        (mmr === bestMmr && (bestIdx < 0 || idx < bestIdx))
      ) {
        bestMmr = mmr;
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) break;
    selectedIdx.push(bestIdx);
    remaining.delete(bestIdx);
  }

  const selected: C[] = selectedIdx.map((i) => pool[i]!);

  // If the caller set a budget larger than topN, append tail candidates in
  // their original order until budget is filled. This keeps MMR scoped to the
  // top-N slice while still respecting the caller's requested size.
  if (selected.length < budget && tail.length > 0) {
    for (const c of tail) {
      if (selected.length >= budget) break;
      selected.push(c);
    }
  }

  return selected;
}

/**
 * Summarize how much MMR reshuffled the head of the candidate list, for
 * logging. Optional — callers can skip this if they don't care about metrics.
 *
 * IMPORTANT: `before` should be the score-ordered input (the same ordering the
 * upstream reranker emitted, *not* the MMR output), and `after` should be the
 * MMR-reordered list. Both are truncated to `sampleSize` before their pairwise
 * similarity is averaged.
 *
 * The sample size intentionally defaults to a small number
 * ({@link DEFAULT_DIVERSITY_SAMPLE_SIZE}) so that when the caller uses
 * `budget >= candidates.length` (i.e. MMR only reorders without dropping), the
 * head-of-list comparison still reflects whether MMR promoted diverse
 * candidates. Passing a sample size `>= candidates.length` in that situation
 * makes `avgPairwiseSimBefore` and `avgPairwiseSimAfter` trivially equal
 * because pairwise similarity is order-independent.
 */
export function summarizeMmrDiversity<C extends MmrCandidate>(
  before: readonly C[],
  after: readonly C[],
  sampleSize: number = DEFAULT_DIVERSITY_SAMPLE_SIZE,
): MmrDiversityReport {
  const n = clampPositiveInt(sampleSize, DEFAULT_DIVERSITY_SAMPLE_SIZE);
  const beforeSlice = before.slice(0, n);
  const afterSlice = after.slice(0, n);
  return {
    considered: beforeSlice.length,
    kept: afterSlice.length,
    avgPairwiseSimBefore: averagePairwiseSimilarity(beforeSlice),
    avgPairwiseSimAfter: averagePairwiseSimilarity(afterSlice),
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function clampLambda(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LAMBDA;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampPositiveInt(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return Math.floor(value);
}

function computeRelevanceScores<C extends MmrCandidate>(
  pool: readonly C[],
  queryEmbedding: readonly number[] | null | undefined,
): number[] {
  // If we have a query embedding, use cosine against each candidate embedding
  // where possible. Candidates without embeddings fall back to normalized score.
  const canUseQueryEmbedding =
    Array.isArray(queryEmbedding) && queryEmbedding.length > 0;

  if (canUseQueryEmbedding) {
    const scores: number[] = [];
    for (const c of pool) {
      if (Array.isArray(c.embedding) && c.embedding.length > 0) {
        scores.push(cosineSimilarity(queryEmbedding!, c.embedding));
      } else {
        // Fall back to the upstream relevance score for this one candidate.
        scores.push(normalizeFinite(c.score));
      }
    }
    return normalizeVector(scores);
  }

  // No query embedding — use normalized candidate scores.
  const raw = pool.map((c) => normalizeFinite(c.score));
  return normalizeVector(raw);
}

function similarity<C extends MmrCandidate>(a: C, b: C): number {
  if (
    Array.isArray(a.embedding) &&
    a.embedding.length > 0 &&
    Array.isArray(b.embedding) &&
    b.embedding.length > 0 &&
    a.embedding.length === b.embedding.length
  ) {
    return cosineSimilarity(a.embedding, b.embedding);
  }
  return jaccardSimilarity(a.content ?? "", b.content ?? "");
}

function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  // Clamp to [0, 1]. Negative cosines (opposite directions) are treated as 0
  // for MMR purposes — two embeddings pointing opposite ways should be
  // "maximally diverse", not discouraged further.
  if (cos < 0) return 0;
  if (cos > 1) return 1;
  return cos;
}

export function normalizeTokens(text: string): Set<string> {
  if (!text) return new Set();
  // Lowercase, strip punctuation to spaces, collapse runs, split.
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (cleaned.length === 0) return new Set();
  return new Set(cleaned.split(/\s+/));
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function normalizeFinite(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function normalizeVector(values: number[]): number[] {
  if (values.length === 0) return values;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return values.map(() => 0);
  }
  if (max === min) {
    // All scores equal — give everyone 1 so diversity fully drives selection.
    return values.map(() => 1);
  }
  const span = max - min;
  return values.map((v) => (v - min) / span);
}

function averagePairwiseSimilarity<C extends MmrCandidate>(
  candidates: readonly C[],
): number {
  if (candidates.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      sum += similarity(candidates[i]!, candidates[j]!);
      count += 1;
    }
  }
  if (count === 0) return 0;
  return sum / count;
}

// -----------------------------------------------------------------------------
// Orchestration helper: MMR for recall results keyed by path-first
// -----------------------------------------------------------------------------

/**
 * Minimum shape the recall-MMR orchestration helper expects from a result.
 * Any richer result type (e.g. {@link QmdSearchResult}) satisfies this.
 */
export interface MmrRecallResult {
  readonly docid?: string;
  readonly path?: string;
  readonly snippet?: string;
  readonly score?: number;
}

export interface ReorderRecallResultsOptions {
  readonly lambda?: number;
  readonly topN?: number;
  /**
   * Head-of-list sample size used by the diversity metric. Defaults to
   * {@link DEFAULT_DIVERSITY_SAMPLE_SIZE}. Intentionally small so the metric
   * reflects head-of-list changes even when `budget >= results.length`.
   */
  readonly diversitySampleSize?: number;
}

export interface ReorderRecallResultsOutcome<R extends MmrRecallResult> {
  readonly reordered: R[];
  readonly diversity: MmrDiversityReport;
  readonly lambda: number;
}

/**
 * Apply MMR to an ordered list of recall results and return the reordered
 * list plus a head-of-list diversity report.
 *
 * This helper is the single source of truth for the orchestrator's
 * per-section MMR pass. It is pure and deterministic so it can be unit
 * tested without constructing an Orchestrator.
 *
 * Key invariants:
 * 1. **No silent drops.** Candidates are keyed by a stable unique key derived
 *    from `path` first, falling back to `docid`, and always suffixed with the
 *    candidate's original index. Two results that share a basename-style
 *    docid but differ in path are treated as distinct candidates and both
 *    survive the reorder.
 * 2. **No mutation.** The input array is never mutated; a new array is
 *    returned.
 * 3. **Diversity metric is meaningful.** The report compares the *head of
 *    list* before and after MMR using a small sample size, so it reflects
 *    whether MMR promoted diverse candidates even when
 *    `budget >= results.length`.
 */
export function reorderRecallResultsWithMmr<R extends MmrRecallResult>(
  results: readonly R[],
  options: ReorderRecallResultsOptions = {},
): ReorderRecallResultsOutcome<R> {
  const emptyReport: MmrDiversityReport = {
    considered: 0,
    kept: 0,
    avgPairwiseSimBefore: 0,
    avgPairwiseSimAfter: 0,
  };
  const lambda = clampLambda(options.lambda);

  if (!Array.isArray(results) || results.length === 0) {
    return { reordered: [], diversity: emptyReport, lambda };
  }
  if (results.length < 2) {
    return {
      reordered: [results[0]!],
      diversity: emptyReport,
      lambda,
    };
  }

  const topN = clampPositiveInt(options.topN, DEFAULT_TOP_N);

  // Build a per-result *unique* key so distinct results with colliding
  // docids or paths are never silently collapsed by id-based lookups.
  const candidateKeys: string[] = new Array(results.length);
  const byKey = new Map<string, R>();
  const candidates: MmrCandidate[] = results.map((r, index) => {
    const key = makeRecallKey(r, index);
    candidateKeys[index] = key;
    byKey.set(key, r);
    return {
      id: key,
      content: r.snippet ?? "",
      score: typeof r.score === "number" ? r.score : 0,
      embedding: null,
    };
  });

  const selectedMmr = applyMmrToCandidates({
    candidates,
    lambda,
    topN,
    budget: results.length,
  });

  const reordered: R[] = [];
  const seen = new Set<string>();
  for (const c of selectedMmr) {
    if (seen.has(c.id)) continue;
    const original = byKey.get(c.id);
    if (!original) continue;
    seen.add(c.id);
    reordered.push(original);
  }
  // Safety: append any candidates MMR did not select so nothing is dropped.
  if (reordered.length < results.length) {
    for (let i = 0; i < results.length; i += 1) {
      const key = candidateKeys[i]!;
      if (seen.has(key)) continue;
      seen.add(key);
      reordered.push(results[i]!);
    }
  }

  const reorderedCandidates: MmrCandidate[] = reordered.map((r, index) => ({
    id: makeRecallKey(r, index),
    content: r.snippet ?? "",
    score: typeof r.score === "number" ? r.score : 0,
    embedding: null,
  }));
  const diversity = summarizeMmrDiversity(
    candidates,
    reorderedCandidates,
    options.diversitySampleSize,
  );

  return { reordered, diversity, lambda };
}

function makeRecallKey(r: MmrRecallResult, index: number): string {
  const baseKey = r.path || r.docid || "";
  return `${baseKey}::${index}`;
}
