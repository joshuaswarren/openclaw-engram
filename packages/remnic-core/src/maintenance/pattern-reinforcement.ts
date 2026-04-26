/**
 * Pattern-reinforcement maintenance job (issue #687 PR 2/4).
 *
 * Reads all memories via `StorageManager.readAllMemories()`, clusters
 * non-procedural memories by normalized content, and reinforces the
 * most-recent member of each large-enough cluster:
 *
 *   1. Cluster across active AND already-superseded members.  This is
 *      load-bearing: after the first reinforcement pass, older
 *      duplicates are marked `superseded`, so on the next pass the
 *      "active count" alone would be just `canonical + N-new`.  By
 *      keeping superseded members in the cluster for the threshold
 *      check, an established canonical (count >= minCount) keeps
 *      growing as soon as a single new duplicate arrives.
 *      `forgotten` / `archived` / `quarantined` / `pending_review` /
 *      `rejected` stay excluded per CLAUDE.md rule 53.
 *   2. Pick the most-recent ACTIVE member of each cluster as the
 *      canonical.  Stamp it with `reinforcement_count` (total cluster
 *      size including superseded members) and `last_reinforced_at`.
 *      Record provenance: `derived_from = [...source-ids...]` and
 *      `derived_via = "pattern-reinforcement"`.
 *   3. Mark any still-active duplicates with `status: "superseded"`
 *      and point `supersededBy` at the canonical id.
 *
 * The job is idempotent: re-running on the same corpus does not
 * double-bump `reinforcement_count` (the bump-only-on-change guard
 * compares cluster size to the canonical's previous counter), and
 * already-superseded duplicates simply pass through.
 *
 * Recall integration (boost from `reinforcement_count`) and the CLI
 * surface ship in PR 3/4 and PR 4/4 respectively — this PR only wires
 * the maintenance job and storage plumbing.
 */

import { clusterByKey } from "../procedural/reinforcement-core.js";
import type {
  MemoryFile,
  MemoryFrontmatter,
  MemoryStatus,
} from "../types.js";

/**
 * Storage surface the job needs.  Defined as a structural interface so
 * tests can pass an in-memory stub without booting a full
 * `StorageManager` (mirrors the pattern in `forget.ts`).
 */
export interface PatternReinforcementStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  writeMemoryFrontmatter(
    memory: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
  ): Promise<boolean>;
}

export interface PatternReinforcementOptions {
  /** Categories the job considers (e.g. ["preference", "fact", "decision"]). */
  categories: readonly string[];
  /** Minimum cluster size required to promote a canonical. */
  minCount: number;
  /** ISO 8601 timestamp source.  Defaults to `Date.now()`. */
  now?: () => Date;
}

export interface PatternReinforcementClusterResult {
  /** Memory id of the canonical (most-recent) member. */
  canonicalId: string;
  /** Cluster size at run time (mirrors `reinforcement_count`). */
  count: number;
  /** IDs of the source memories that contributed (canonical + duplicates). */
  sourceIds: readonly string[];
  /** IDs of the older duplicates that were marked superseded. */
  supersededIds: readonly string[];
  /**
   * `true` when the canonical's `reinforcement_count` actually
   * changed during this run.  False when the job converged
   * idempotently (same cluster size as the previous run).
   */
  reinforcementBumped: boolean;
}

export interface PatternReinforcementResult {
  /** Number of clusters that met the `minCount` threshold. */
  clustersFound: number;
  /** Number of canonical memories whose reinforcement counter changed. */
  canonicalsUpdated: number;
  /** Total duplicate memories newly marked `status: "superseded"`. */
  duplicatesSuperseded: number;
  /** Per-cluster details for tests / observability. */
  clusters: PatternReinforcementClusterResult[];
}

/**
 * Cluster key derivation: lowercase + collapse whitespace + truncate to
 * 200 chars.  Pure helper so callers and tests can compute the same key
 * without re-implementing the rule.
 *
 * Truncation is intentional — long-form content with a stable opening
 * still clusters together even when the tail differs slightly.  200
 * chars matches the spec.
 *
 * @deprecated Prefer `patternReinforcementClusterKey(category, content)`
 * which partitions by memory category so identical text in different
 * categories does not get cross-superseded (PR #730 review feedback,
 * Codex P2).  This bare helper is kept exported for backward
 * compatibility with callers that already partition by category
 * upstream.
 */
export function patternReinforcementKey(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Cluster key derivation that includes the memory category as a prefix
 * so identical text under different categories (e.g. `fact` and
 * `decision`) does not collapse into one cluster.  Without this,
 * pattern reinforcement would silently supersede a fact when a
 * decision happens to share the same canonical text — distorting
 * downstream category-scoped retrieval and governance behavior (PR
 * #730 review feedback, Codex P2).
 */
export function patternReinforcementClusterKey(category: string, content: string): string {
  // Use a `::` separator that cannot appear in either component so
  // a category like `fact` plus content starting with `decision:...`
  // cannot collide with category `decision`.
  return `${category}::${patternReinforcementKey(content)}`;
}

/**
 * Compare two memories by their effective timestamp.
 *
 * Parses each timestamp to an *instant* (epoch ms) via `Date.parse`
 * rather than lexicographic `localeCompare` so ISO-8601 variants with
 * non-`Z` offsets (e.g. `2026-04-26T10:00:00+02:00`) and mixed
 * millisecond precision compare by actual time rather than by raw
 * string (PR #730 review feedback, Codex P2).  Imported / hand-edited
 * memory files routinely use such variants.
 *
 * Falls back to the raw string when an instant is unparseable (a
 * corrupt frontmatter is rare but possible) and tie-breaks on memory
 * id for stable ordering.
 */
function pickCanonical(memories: MemoryFile[]): MemoryFile {
  let best = memories[0];
  let bestInstant = memoryInstant(best);
  let bestStamp = memoryStamp(best);
  for (let i = 1; i < memories.length; i += 1) {
    const candidate = memories[i];
    const instant = memoryInstant(candidate);
    const stamp = memoryStamp(candidate);
    let cmp: number;
    if (instant !== null && bestInstant !== null) {
      cmp = instant - bestInstant;
    } else {
      // One side is unparseable — fall back to lexicographic compare
      // on raw strings.  This keeps ordering deterministic even when
      // a corrupt timestamp slipped past the parser.
      cmp = stamp.localeCompare(bestStamp);
    }
    if (cmp > 0 || (cmp === 0 && candidate.frontmatter.id > best.frontmatter.id)) {
      best = candidate;
      bestInstant = instant;
      bestStamp = stamp;
    }
  }
  return best;
}

function memoryStamp(memory: MemoryFile): string {
  // Prefer `updated`, fall back to `created`.  Both are ISO-8601 and
  // present on every well-formed memory; the parser default-fills them
  // when absent.
  return memory.frontmatter.updated || memory.frontmatter.created || "";
}

/**
 * Parse a memory's effective timestamp to epoch milliseconds.  Returns
 * `null` for an unparseable / empty stamp so callers can fall back to
 * a string compare without observing `NaN` propagation.
 */
function memoryInstant(memory: MemoryFile): number | null {
  const stamp = memoryStamp(memory);
  if (stamp.length === 0) return null;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}

const ACTIVE_STATUS: MemoryStatus = "active";

/**
 * Run pattern reinforcement across the configured categories.
 *
 * The function is intentionally pure (modulo the storage handle): no
 * cron scheduling, no telemetry side effects, no logging.  Callers
 * (orchestrator cron path / CLI surface in PR 4) own those concerns.
 */
export async function runPatternReinforcement(
  storage: PatternReinforcementStorage,
  options: PatternReinforcementOptions,
): Promise<PatternReinforcementResult> {
  const minCount = Math.max(2, Math.floor(options.minCount));
  const targetCategories = new Set(options.categories);
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();

  // No-op fast paths so unconfigured callers get a clean result rather
  // than walking the entire corpus.
  if (targetCategories.size === 0) {
    return emptyResult();
  }

  const memories = await storage.readAllMemories();

  // Cluster across BOTH active and already-superseded memories so a
  // canonical that has previously absorbed duplicates still gets
  // reinforced when a single new duplicate arrives (Codex P1).
  // Without this, the post-first-pass active set is just
  // `canonical + N-new`, which falls below `minCount` for any
  // realistic cadence.  CLAUDE.md rule 53 still applies — forgotten,
  // archived, quarantined, pending_review, and rejected memories
  // remain excluded.
  const eligible = memories.filter((m) => {
    if (!targetCategories.has(m.frontmatter.category)) return false;
    const status = m.frontmatter.status ?? ACTIVE_STATUS;
    return status === ACTIVE_STATUS || status === "superseded";
  });

  if (eligible.length === 0) return emptyResult();

  // Cluster by `<category> <content>` so identical text in different
  // categories does not get cross-superseded (PR #730 review feedback,
  // Codex P2).
  const clusters = clusterByKey(eligible, (m) =>
    patternReinforcementClusterKey(m.frontmatter.category, m.content),
  );

  const result: PatternReinforcementResult = {
    clustersFound: 0,
    canonicalsUpdated: 0,
    duplicatesSuperseded: 0,
    clusters: [],
  };

  for (const cluster of clusters.values()) {
    // The cluster represents the full historical pattern — its size
    // is the threshold the user configured against.
    if (cluster.length < minCount) continue;

    // Active members are the only ones we can write to (or pick as
    // canonical).  If every member is already superseded — e.g. a
    // prior canonical was archived externally — there's nothing to
    // do for this cluster on this pass.
    const activeMembers = cluster.filter((m) => {
      const status = m.frontmatter.status ?? ACTIVE_STATUS;
      return status === ACTIVE_STATUS;
    });
    if (activeMembers.length === 0) continue;

    result.clustersFound += 1;

    const canonical = pickCanonical(activeMembers);
    const activeDuplicates = activeMembers.filter((m) => m !== canonical);

    // Source-id provenance: include the canonical + every member
    // that contributed to the cluster (active and superseded), so
    // the lineage is fully reconstructible.  Sort ids
    // deterministically (CLAUDE.md rule 38) so re-runs produce
    // stable on-disk output.
    const sourceIds = [...cluster]
      .map((m) => m.frontmatter.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();

    const previousCount = canonical.frontmatter.reinforcement_count ?? 0;
    const newCount = cluster.length;
    const reinforcementBumped = newCount > previousCount;

    // Patch the canonical only when the cluster actually grew —
    // idempotent re-runs on a stable corpus produce zero writes.
    if (reinforcementBumped) {
      const patch: Partial<MemoryFrontmatter> = {
        reinforcement_count: newCount,
        last_reinforced_at: nowIso,
        derived_from: sourceIds,
        derived_via: "pattern-reinforcement",
        updated: nowIso,
      };
      await storage.writeMemoryFrontmatter(canonical, patch);
      result.canonicalsUpdated += 1;
    }

    // Supersede any still-active duplicates.  Already-superseded
    // members were filtered out above, which doubles as our
    // crash-recovery guard: a previous run that died mid-supersede
    // simply re-runs the active half on the next pass.
    const supersededIds: string[] = [];
    for (const dup of activeDuplicates) {
      const patch: Partial<MemoryFrontmatter> = {
        status: "superseded",
        supersededBy: canonical.frontmatter.id,
        supersededAt: nowIso,
        updated: nowIso,
      };
      await storage.writeMemoryFrontmatter(dup, patch);
      supersededIds.push(dup.frontmatter.id);
      result.duplicatesSuperseded += 1;
    }

    result.clusters.push({
      canonicalId: canonical.frontmatter.id,
      count: newCount,
      sourceIds,
      supersededIds,
      reinforcementBumped,
    });
  }

  return result;
}

function emptyResult(): PatternReinforcementResult {
  return {
    clustersFound: 0,
    canonicalsUpdated: 0,
    duplicatesSuperseded: 0,
    clusters: [],
  };
}
