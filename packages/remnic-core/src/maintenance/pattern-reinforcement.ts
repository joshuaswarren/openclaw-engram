/**
 * Pattern-reinforcement maintenance job (issue #687 PR 2/4).
 *
 * Reads all memories via `StorageManager.readAllMemories()`, clusters
 * non-procedural memories by normalized content, and reinforces the
 * most-recent member of each large-enough cluster:
 *
 *   1. Pick the most-recent memory in the cluster as the canonical.
 *   2. Stamp the canonical with `reinforcement_count` (cluster size)
 *      and `last_reinforced_at` (job timestamp).  Record provenance:
 *      `derived_from = [...source-ids...]` and
 *      `derived_via = "pattern-reinforcement"` so the lineage is
 *      traceable.
 *   3. Mark the older duplicates with `status: "superseded"` and
 *      point `supersededBy` at the canonical id.
 *
 * The job is idempotent: re-running on the same corpus does not
 * double-bump `reinforcement_count`.  Already-superseded duplicates
 * are skipped via the active-status filter, so only newly-discovered
 * duplicates contribute to subsequent reinforcement.
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
 */
export function patternReinforcementKey(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Compare two ISO-8601 timestamps lexicographically.  ISO-8601 sorts
 * chronologically as a string so we don't pay for `Date` parsing in a
 * tight loop.  Falls back to memory id for stable ordering when
 * timestamps tie.
 */
function pickCanonical(memories: MemoryFile[]): MemoryFile {
  let best = memories[0];
  let bestStamp = memoryStamp(best);
  for (let i = 1; i < memories.length; i += 1) {
    const candidate = memories[i];
    const stamp = memoryStamp(candidate);
    const cmp = stamp.localeCompare(bestStamp);
    if (cmp > 0 || (cmp === 0 && candidate.frontmatter.id > best.frontmatter.id)) {
      best = candidate;
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

  // Filter to active, in-scope memories.  Only consider memories whose
  // status is implicitly or explicitly "active" — superseded /
  // archived / forgotten / quarantined memories are out of scope per
  // CLAUDE.md rule 53.
  const candidates = memories.filter((m) => {
    if (!targetCategories.has(m.frontmatter.category)) return false;
    const status = m.frontmatter.status ?? ACTIVE_STATUS;
    return status === ACTIVE_STATUS;
  });

  if (candidates.length === 0) return emptyResult();

  const clusters = clusterByKey(candidates, (m) =>
    patternReinforcementKey(m.content),
  );

  const result: PatternReinforcementResult = {
    clustersFound: 0,
    canonicalsUpdated: 0,
    duplicatesSuperseded: 0,
    clusters: [],
  };

  for (const cluster of clusters.values()) {
    if (cluster.length < minCount) continue;
    result.clustersFound += 1;

    const canonical = pickCanonical(cluster);
    const duplicates = cluster.filter((m) => m !== canonical);

    // Source-id provenance: include canonical + duplicates so the
    // lineage is fully reconstructible.  Sort ids deterministically
    // (CLAUDE.md rule 38) so re-runs produce stable on-disk output.
    const sourceIds = [...cluster]
      .map((m) => m.frontmatter.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();

    const previousCount = canonical.frontmatter.reinforcement_count ?? 0;
    const newCount = cluster.length;
    const reinforcementBumped = newCount > previousCount;

    // Patch the canonical only when something actually changed —
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

    // Supersede any active duplicates that haven't already been
    // pointed at the canonical.  Skipping already-linked duplicates
    // keeps the job idempotent under partial completion (e.g. a
    // previous run crashed midway).
    const supersededIds: string[] = [];
    for (const dup of duplicates) {
      if (
        dup.frontmatter.status === "superseded" &&
        dup.frontmatter.supersededBy === canonical.frontmatter.id
      ) {
        continue;
      }
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
