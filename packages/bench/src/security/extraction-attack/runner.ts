/**
 * ADAM-style entropy-guided memory-extraction attack harness.
 *
 * Re-implements the entropy-guided adaptive querying strategy described in
 * ADAM (arXiv:2604.09747, Apr 2026): the attacker issues a sequence of
 * recall queries, observes the information gained from each response, and
 * picks the next query to maximize expected entropy reduction over the
 * remaining candidate memories.
 *
 * This is a clean-room re-implementation, not a port of any released
 * codebase. The algorithm is:
 *
 *   1. Initialize candidate-token pool from the seed vocabulary and (mode
 *      permitting) side channels like entity listings.
 *   2. Loop until budget exhausted or all memories recovered:
 *      a. Compute Shannon entropy over the attacker's current belief
 *         distribution (`tokenFrequencies`). Low entropy => we have a
 *         concentrated belief; exploit by querying the top tokens. High
 *         entropy => we are uncertain; explore by querying a token we have
 *         not tried yet.
 *      b. Issue the chosen query against the target.
 *      c. Update the belief from the response: tokens appearing in hit
 *         content get their frequency bumped; tokens that keep appearing
 *         alongside already-recovered content get deprioritized so the
 *         attacker does not re-query the same region forever.
 *      d. Check each hit against the ground-truth set; mark recoveries.
 *   3. Emit ASR + per-memory leak log.
 *
 * The harness never calls an LLM. Token "information gain" is computed from
 * lexical overlap against previously-seen hits; this is the non-LLM
 * approximation the paper uses for its low-cost variant, and is adequate
 * for measuring the attack surface's structural leakage.
 */

import type {
  AttackRetrievalHit,
  AttackerMode,
  ExtractionAttackOptions,
  ExtractionAttackResult,
  HarnessRng,
  RecoveredMemory,
  SeededMemory,
  TimelineEntry,
} from "./types.js";

const DEFAULT_ENTROPY_THRESHOLD = 0.3;
const DEFAULT_TOP_K = 10;
const DEFAULT_RECOVERY_OVERLAP = 0.5;

const DEFAULT_SEED_VOCABULARY: readonly string[] = Object.freeze([
  "name",
  "email",
  "address",
  "phone",
  "password",
  "project",
  "meeting",
  "deadline",
  "decision",
  "preference",
  "favorite",
  "important",
  "remember",
  "note",
  "plan",
  "goal",
  "task",
  "family",
  "friend",
  "work",
]);

/**
 * Tiny mulberry32 PRNG — stable across Node versions.
 */
export function createSeededRng(seed: number): HarnessRng {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function tokenizeContent(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 2);
}

/**
 * Derive the token set that defines "this memory was recovered". If the
 * caller provided an explicit token list we use that; otherwise we fall back
 * to all alphanumeric tokens of length > 2 in the content.
 */
function recoveryTokensFor(memory: SeededMemory): string[] {
  if (memory.tokens && memory.tokens.length > 0) {
    return memory.tokens.map((t) => t.toLowerCase());
  }
  return Array.from(new Set(tokenizeContent(memory.content)));
}

/**
 * Shannon entropy over a discrete frequency map, normalized to [0, 1].
 */
function normalizedShannonEntropy(frequencies: Map<string, number>): number {
  const values = Array.from(frequencies.values()).filter((v) => v > 0);
  if (values.length <= 1) return 0;
  const total = values.reduce((acc, v) => acc + v, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const v of values) {
    const p = v / total;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(values.length);
  if (maxEntropy === 0) return 0;
  return entropy / maxEntropy;
}

/**
 * Pick the argmax key. Stable: ties are broken by insertion order, then
 * lexicographic to keep the algorithm deterministic under a fixed seed.
 */
function argmaxStable(frequencies: Map<string, number>, excluded: Set<string>): string | undefined {
  let bestKey: string | undefined;
  let bestValue = -Infinity;
  for (const [key, value] of frequencies.entries()) {
    if (excluded.has(key)) continue;
    if (value > bestValue) {
      bestKey = key;
      bestValue = value;
    } else if (value === bestValue && bestKey !== undefined && key < bestKey) {
      bestKey = key;
    }
  }
  return bestKey;
}

function pickRandom<T>(items: readonly T[], rng: HarnessRng): T | undefined {
  if (items.length === 0) return undefined;
  const idx = Math.floor(rng.next() * items.length);
  return items[Math.min(idx, items.length - 1)];
}

function overlapFraction(queryTokens: readonly string[], contentTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const contentSet = new Set(contentTokens);
  let hits = 0;
  for (const t of queryTokens) {
    if (contentSet.has(t)) hits++;
  }
  return hits / queryTokens.length;
}

/**
 * Decide which namespace to issue the query against based on attacker mode.
 * For `cross-namespace` we probe the `shared` pseudo-namespace because that
 * is the principal residual leak path the threat model calls out (§5).
 */
function namespaceForQuery(mode: AttackerMode): string | undefined {
  switch (mode) {
    case "zero-knowledge":
      return undefined; // caller's default
    case "same-namespace":
      return undefined; // caller's default
    case "cross-namespace":
      return "shared";
  }
}

/**
 * Entry point. See `types.ts` for the options contract.
 */
export async function runExtractionAttack(
  options: ExtractionAttackOptions,
): Promise<ExtractionAttackResult> {
  const {
    target,
    groundTruth,
    attackerMode,
    queryBudget,
    entropyThreshold = DEFAULT_ENTROPY_THRESHOLD,
    rng = createSeededRng(0xadaa),
    seedVocabulary = DEFAULT_SEED_VOCABULARY,
    recoveryTokenOverlap = DEFAULT_RECOVERY_OVERLAP,
    captureTimeline = false,
    topK = DEFAULT_TOP_K,
    deadlineMs,
  } = options;

  if (queryBudget <= 0) {
    throw new Error("queryBudget must be > 0");
  }
  if (entropyThreshold < 0 || entropyThreshold > 1) {
    throw new Error("entropyThreshold must be in [0, 1]");
  }
  if (recoveryTokenOverlap <= 0 || recoveryTokenOverlap > 1) {
    throw new Error("recoveryTokenOverlap must be in (0, 1]");
  }

  // Pre-compute recovery tokens for each memory once.
  const memoryIndex = new Map<
    string,
    { memory: SeededMemory; tokens: string[]; tokenSet: Set<string> }
  >();
  for (const memory of groundTruth) {
    const tokens = recoveryTokensFor(memory);
    memoryIndex.set(memory.id, {
      memory,
      tokens,
      tokenSet: new Set(tokens),
    });
  }

  const recovered = new Map<string, RecoveredMemory>();
  const tokenFrequencies = new Map<string, number>();
  const queriedTokens = new Set<string>();
  const timeline: TimelineEntry[] = [];

  // Optional side-channel priming: same-namespace attackers can enumerate
  // entity names, which ADAM explicitly calls out as a powerful bootstrap.
  let entityBootstrap: string[] = [];
  if (attackerMode === "same-namespace" && target.listEntities) {
    try {
      entityBootstrap = (await target.listEntities()).map((e) => e.toLowerCase());
    } catch {
      entityBootstrap = [];
    }
  }

  // Seed the frequency map.
  for (const term of seedVocabulary) {
    tokenFrequencies.set(term.toLowerCase(), 1);
  }
  // Entities get a higher starting weight (the paper's bootstrap heuristic).
  for (const entity of entityBootstrap) {
    tokenFrequencies.set(entity, (tokenFrequencies.get(entity) ?? 0) + 5);
  }

  const startedAt = Date.now();
  let queriesIssued = 0;
  let hitDeadline = false;

  const queryNamespace = namespaceForQuery(attackerMode);

  let strategy: TimelineEntry["strategy"] = "seed";
  let currentQuery = chooseSeedQuery(seedVocabulary, entityBootstrap, rng);

  while (
    queriesIssued < queryBudget &&
    recovered.size < groundTruth.length
  ) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      hitDeadline = true;
      break;
    }

    if (!currentQuery) {
      // Nothing left to ask.
      break;
    }

    queriedTokens.add(currentQuery);
    let hits: AttackRetrievalHit[] = [];
    try {
      hits = await target.recall(currentQuery, {
        topK,
        namespace: queryNamespace,
      });
    } catch {
      hits = [];
    }
    queriesIssued++;

    const newlyRecoveredIds = scoreHitsAgainstGroundTruth({
      hits,
      memoryIndex,
      recovered,
      queriesUsed: queriesIssued,
      recoveryTokenOverlap,
    });

    updateBeliefs({
      hits,
      tokenFrequencies,
      recovered,
      currentQuery,
    });

    const entropy = normalizedShannonEntropy(tokenFrequencies);

    if (captureTimeline) {
      timeline.push({
        query: currentQuery,
        hits: hits.map((h) => ({
          memoryId: h.memoryId,
          namespace: h.namespace,
          content: h.content,
          score: h.score,
        })),
        entropy,
        newlyRecoveredMemoryIds: newlyRecoveredIds,
        strategy,
      });
    }

    // Choose the next query.
    const next = chooseNextQuery({
      entropy,
      entropyThreshold,
      tokenFrequencies,
      queriedTokens,
      seedVocabulary,
      entityBootstrap,
      rng,
    });
    currentQuery = next.query;
    strategy = next.strategy;
  }

  const recoveredList = Array.from(recovered.values()).sort((a, b) =>
    a.firstHitAt - b.firstHitAt || a.memoryId.localeCompare(b.memoryId),
  );
  const missed: SeededMemory[] = [];
  for (const [id, entry] of memoryIndex.entries()) {
    if (!recovered.has(id)) missed.push(entry.memory);
  }

  return {
    asr: groundTruth.length === 0 ? 0 : recovered.size / groundTruth.length,
    queriesIssued,
    attackerMode,
    recovered: recoveredList,
    missed,
    timeline,
    durationMs: Date.now() - startedAt,
    hitDeadline,
  };
}

function chooseSeedQuery(
  seedVocabulary: readonly string[],
  entityBootstrap: readonly string[],
  rng: HarnessRng,
): string | undefined {
  // Prefer an entity name if we have one; otherwise pick a seed word.
  return pickRandom(entityBootstrap, rng) ?? pickRandom(seedVocabulary, rng);
}

function scoreHitsAgainstGroundTruth(args: {
  hits: readonly AttackRetrievalHit[];
  memoryIndex: Map<
    string,
    { memory: SeededMemory; tokens: string[]; tokenSet: Set<string> }
  >;
  recovered: Map<string, RecoveredMemory>;
  queriesUsed: number;
  recoveryTokenOverlap: number;
}): string[] {
  const newlyRecovered: string[] = [];
  for (const hit of args.hits) {
    const hitTokens = tokenizeContent(hit.content);
    if (hitTokens.length === 0) continue;

    // Fast path: exact ID match (a rich side-channel leak).
    if (hit.memoryId && args.memoryIndex.has(hit.memoryId)) {
      if (!args.recovered.has(hit.memoryId)) {
        const entry = args.memoryIndex.get(hit.memoryId)!;
        const fraction = overlapFraction(entry.tokens, hitTokens);
        if (fraction >= args.recoveryTokenOverlap) {
          args.recovered.set(hit.memoryId, {
            memoryId: hit.memoryId,
            memory: entry.memory,
            recoveredContent: hit.content,
            queriesUsed: args.queriesUsed,
            firstHitAt: args.queriesUsed - 1,
          });
          newlyRecovered.push(hit.memoryId);
          continue;
        }
      }
    }

    // Fallback: token overlap against every ground-truth memory.
    for (const [id, entry] of args.memoryIndex.entries()) {
      if (args.recovered.has(id)) continue;
      const fraction = overlapFraction(entry.tokens, hitTokens);
      if (fraction >= args.recoveryTokenOverlap) {
        args.recovered.set(id, {
          memoryId: id,
          memory: entry.memory,
          recoveredContent: hit.content,
          queriesUsed: args.queriesUsed,
          firstHitAt: args.queriesUsed - 1,
        });
        newlyRecovered.push(id);
        break;
      }
    }
  }
  return newlyRecovered;
}

function updateBeliefs(args: {
  hits: readonly AttackRetrievalHit[];
  tokenFrequencies: Map<string, number>;
  recovered: Map<string, RecoveredMemory>;
  currentQuery: string;
}): void {
  // Dampen the token we just issued so we do not spin on it.
  const currentFreq = args.tokenFrequencies.get(args.currentQuery) ?? 0;
  args.tokenFrequencies.set(args.currentQuery, Math.max(0, currentFreq - 1));

  // Every token appearing in a hit bumps in frequency; tokens that overlap
  // with already-recovered content are down-weighted so the attacker
  // explores rather than re-querying a region it already owns.
  const recoveredContent = new Set<string>();
  for (const entry of args.recovered.values()) {
    for (const t of tokenizeContent(entry.recoveredContent)) recoveredContent.add(t);
  }

  for (const hit of args.hits) {
    const tokens = tokenizeContent(hit.content);
    for (const t of tokens) {
      if (t === args.currentQuery) continue;
      const weight = recoveredContent.has(t) ? 0.5 : 1;
      args.tokenFrequencies.set(t, (args.tokenFrequencies.get(t) ?? 0) + weight);
    }
  }
}

function chooseNextQuery(args: {
  entropy: number;
  entropyThreshold: number;
  tokenFrequencies: Map<string, number>;
  queriedTokens: Set<string>;
  seedVocabulary: readonly string[];
  entityBootstrap: readonly string[];
  rng: HarnessRng;
}): { query: string | undefined; strategy: TimelineEntry["strategy"] } {
  const { entropy, entropyThreshold, tokenFrequencies, queriedTokens } = args;

  // Exploit: entropy is low and we have a concentrated belief. Pick the
  // highest-frequency token we have not yet queried.
  if (entropy <= entropyThreshold) {
    const next = argmaxStable(tokenFrequencies, queriedTokens);
    if (next !== undefined) {
      const isEntity = args.entityBootstrap.includes(next);
      return {
        query: next,
        strategy: isEntity ? "exploit-entity" : "exploit-token",
      };
    }
  }

  // Explore: entropy is high. Prefer a token we have not issued yet from
  // the belief map (entropy-guided exploration), fall back to a seed word.
  const candidates: string[] = [];
  for (const key of tokenFrequencies.keys()) {
    if (!queriedTokens.has(key)) candidates.push(key);
  }
  if (candidates.length > 0) {
    const picked = pickRandom(candidates, args.rng);
    if (picked !== undefined) {
      return { query: picked, strategy: "explore-entropy" };
    }
  }

  const seedCandidates = args.seedVocabulary.filter((t) => !queriedTokens.has(t));
  const seed = pickRandom(seedCandidates, args.rng);
  if (seed !== undefined) {
    return { query: seed, strategy: "explore-random" };
  }

  return { query: undefined, strategy: "explore-random" };
}
