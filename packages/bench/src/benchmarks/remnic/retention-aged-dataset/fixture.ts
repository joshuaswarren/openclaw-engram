/**
 * Synthetic aged-dataset fixture generator (issue #686 PR 2/6).
 *
 * Generates a hermetic corpus of memories spanning a configurable horizon
 * with Pareto-distributed query frequencies (a few "hot" topics queried
 * often; long-tail memories rarely queried). The fixture is deterministic
 * given a seed so bench results are reproducible.
 *
 * Why synthetic: the issue's goal is to measure structural properties of
 * the tier policy (recall@K, p95 latency proxy, hot/cold split) at 1- and
 * 2-year scale. A real corpus at that scale is unavailable and would risk
 * leaking personal data into a public-repo bench. The synthetic generator
 * is parameterized so the bench can be tuned for either horizon.
 */

import type { MemoryFile } from "@remnic/core";

export interface AgedDatasetGeneratorOptions {
  /** Total memory count. */
  size: number;
  /** Horizon in days. e.g. 365 (1y), 730 (2y). */
  horizonDays: number;
  /** Number of distinct topics. Each memory belongs to one topic. */
  topicCount: number;
  /**
   * Pareto shape parameter. Higher → more skewed (fewer hot topics carry
   * most queries). 1.16 ≈ Zipf with alpha 1, the classic "80/20" curve.
   */
  paretoAlpha: number;
  /**
   * Age skew. >1 means more old memories than recent (long-tail aged
   * dataset). =1 means uniform. <1 means more recent memories.
   */
  ageSkew: number;
  /** Deterministic seed. */
  seed: number;
  /** ISO timestamp anchoring "now" so bench is reproducible. */
  nowIso: string;
}

export interface AgedQuery {
  /**
   * Unique per-query identifier across the entire fixture. Used as the
   * task identifier in benchmark results; downstream consumers
   * (reporters, dedup, storage) key on this so collisions would
   * silently collapse rows.
   */
  id: string;
  /** Synthetic query text (topic-derived keywords). */
  text: string;
  /** ID of the topic this query targets. */
  topicId: number;
  /** Memory IDs that are relevant ground truth for this query. */
  relevantMemoryIds: string[];
}

export interface AgedDatasetFixture {
  options: AgedDatasetGeneratorOptions;
  memories: MemoryFile[];
  queries: AgedQuery[];
}

/**
 * Mulberry32 PRNG — small, deterministic, fast.
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a Zipf-distributed integer in [0, n).
 * Higher `alpha` = more skewed toward index 0.
 *
 * Uses a Zipf-style discrete distribution: P(rank=k) ∝ (k+1)^-alpha
 * across k ∈ [0, n-1], sampled by inverse-CDF lookup. This produces a
 * true long tail across all ranks; the previous Pareto-clamp approach
 * collapsed high-tail samples onto the last index, creating an
 * artificial second hotspot. (Codex P1 review on PR #698.)
 */
function paretoIndex(rng: () => number, n: number, alpha: number): number {
  if (n <= 1) return 0;
  // Build a rank-weight array (cached per-call; n is small for our bench).
  const weights: number[] = new Array(n);
  let total = 0;
  for (let k = 0; k < n; k += 1) {
    const w = Math.pow(k + 1, -alpha);
    weights[k] = w;
    total += w;
  }
  const u = rng() * total;
  let cum = 0;
  for (let k = 0; k < n; k += 1) {
    cum += weights[k];
    if (u <= cum) return k;
  }
  return n - 1;
}

/**
 * Skewed age in [0, horizonDays].
 * skew=1 → uniform, skew>1 → bias toward old, skew<1 → bias toward recent.
 */
function skewedAgeDays(rng: () => number, horizon: number, skew: number): number {
  const u = rng();
  return Math.floor(Math.pow(u, 1 / skew) * horizon);
}

const TOPIC_KEYWORDS = [
  ["alpha", "primary", "core"],
  ["beta", "secondary", "supporting"],
  ["gamma", "tertiary", "auxiliary"],
  ["delta", "change", "diff"],
  ["epsilon", "tiny", "minor"],
  ["zeta", "edge", "boundary"],
  ["eta", "ratio", "measure"],
  ["theta", "angle", "rotation"],
  ["iota", "small", "incremental"],
  ["kappa", "agreement", "consent"],
  ["lambda", "function", "compute"],
  ["mu", "average", "mean"],
  ["nu", "frequency", "cadence"],
  ["xi", "random", "noise"],
  ["omicron", "small", "letter"],
  ["pi", "circle", "ratio"],
];

function topicWord(topicId: number, slot: number): string {
  const kws = TOPIC_KEYWORDS[topicId % TOPIC_KEYWORDS.length];
  return kws[slot % kws.length];
}

/**
 * Build a synthetic aged-corpus fixture.
 */
export function generateAgedDataset(
  options: AgedDatasetGeneratorOptions,
): AgedDatasetFixture {
  const {
    size,
    horizonDays,
    topicCount,
    paretoAlpha,
    ageSkew,
    seed,
    nowIso,
  } = options;

  if (size <= 0 || !Number.isFinite(size)) {
    throw new Error(`size must be a positive integer, got ${size}`);
  }
  if (topicCount <= 0 || !Number.isFinite(topicCount)) {
    throw new Error(`topicCount must be positive, got ${topicCount}`);
  }
  if (horizonDays <= 0 || !Number.isFinite(horizonDays)) {
    throw new Error(`horizonDays must be positive, got ${horizonDays}`);
  }

  const rng = mulberry32(seed);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`nowIso must be a valid ISO timestamp, got ${nowIso}`);
  }

  const memories: MemoryFile[] = [];
  // Track memories per topic so we can build relevant-id lists for queries.
  const memoriesByTopic: Map<number, string[]> = new Map();

  for (let i = 0; i < size; i += 1) {
    const topicId = paretoIndex(rng, topicCount, paretoAlpha);
    const ageDays = skewedAgeDays(rng, horizonDays, ageSkew);
    const createdMs = nowMs - ageDays * 24 * 60 * 60 * 1000;
    // Recent access bias: a few memories are accessed more often, mostly
    // mirroring the topic Pareto skew (a memory in a hot topic gets more
    // accesses).
    const accessCount = Math.max(
      0,
      Math.floor(rng() * 16 * Math.pow(2, -topicId / 4)),
    );
    const lastAccessedMs =
      accessCount > 0
        ? createdMs +
          Math.floor(rng() * Math.max(1, nowMs - createdMs))
        : createdMs;
    const id = `bench-mem-${seed}-${i.toString(16)}`;
    // Spread confidenceTier across the 4 production tiers so the bench
    // exercises the full range of demotion eligibility. Hot topics
    // (low topicId after Pareto sampling) lean toward "explicit" /
    // "implied"; cold-tail topics lean toward "inferred" / "speculative".
    // This mirrors the realistic distribution of facts produced by
    // extraction at scale.
    const confidenceTier =
      topicId === 0
        ? "explicit"
        : topicId === 1
          ? "implied"
          : topicId < topicCount / 2
            ? "inferred"
            : "speculative";
    const baseConfidence =
      confidenceTier === "explicit"
        ? 0.9
        : confidenceTier === "implied"
          ? 0.75
          : confidenceTier === "inferred"
            ? 0.55
            : 0.3;
    const memoryFile: MemoryFile = {
      path: `synthetic/facts/${id}.md`,
      frontmatter: {
        id,
        category: "fact",
        created: new Date(createdMs).toISOString(),
        updated: new Date(createdMs).toISOString(),
        source: "bench",
        confidence: baseConfidence + (rng() - 0.5) * 0.1,
        confidenceTier,
        tags: [topicWord(topicId, 0)],
        accessCount,
        lastAccessed: new Date(lastAccessedMs).toISOString(),
      },
      content: [
        topicWord(topicId, 0),
        topicWord(topicId, 1),
        topicWord(topicId, 2),
        `record-${i}`,
      ].join(" "),
    };
    memories.push(memoryFile);

    let perTopic = memoriesByTopic.get(topicId);
    if (!perTopic) {
      perTopic = [];
      memoriesByTopic.set(topicId, perTopic);
    }
    perTopic.push(id);
  }

  // Build queries weighted by topic frequency. Topic memory counts are
  // already Pareto-distributed (because memories are sampled with
  // `paretoIndex`), so emitting one query per memory in a topic — rounded
  // by a freq-floor cap so each topic gets at least one query but hot
  // topics get proportionally more — yields aggregate scores that reflect
  // realistic hot-topic-heavy traffic instead of weighting every topic
  // equally. (Codex review on PR #698.)
  //
  // We cap the multiplier per topic at `MAX_QUERIES_PER_TOPIC` to keep
  // total task count tractable in `quick` mode.
  const MAX_QUERIES_PER_TOPIC = 8;
  const queries: AgedQuery[] = [];
  for (const [topicId, ids] of memoriesByTopic.entries()) {
    const topicQueryCount = Math.min(
      MAX_QUERIES_PER_TOPIC,
      Math.max(1, Math.ceil(ids.length / 4)),
    );
    for (let q = 0; q < topicQueryCount; q += 1) {
      queries.push({
        // Include the per-topic instance index so duplicates within a
        // topic stay distinguishable. Other bench runners use unique
        // taskIds; downstream consumers (reporters, dedup, storage)
        // key on taskId, so collisions would silently collapse rows.
        // (Codex review on PR #698.)
        id: `topic-${topicId}-${q}`,
        text: `${topicWord(topicId, 0)} ${topicWord(topicId, 1)}`,
        topicId,
        relevantMemoryIds: ids,
      });
    }
  }
  // Sort by topicId for determinism, with stable ordering within a topic.
  queries.sort((a, b) => {
    if (a.topicId !== b.topicId) return a.topicId - b.topicId;
    return a.id.localeCompare(b.id);
  });

  return { options, memories, queries };
}
