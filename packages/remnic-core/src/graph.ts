/**
 * Multi-Graph Memory (MAGMA/SYNAPSE-inspired, v8.2)
 *
 * Maintains three typed edge graphs:
 *   entity.jsonl  — memories sharing a named entity (entityRef)
 *   time.jsonl    — consecutive memories in the same thread/session
 *   causal.jsonl  — memories linked by causal language heuristics
 *
 * Stored under `<memoryDir>/state/graphs/`.
 * All writes are fail-open: errors are caught/logged, never thrown.
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import * as path from "path";

export type GraphType = "entity" | "time" | "causal";

export interface GraphEdge {
  from: string; // relative memory path (e.g. "facts/2026-02-22/abc.md")
  to: string; // relative memory path
  type: GraphType;
  weight: number; // 1.0 default, decay applied during traversal
  label: string; // entity name, threadId, or matched causal phrase
  ts: string; // ISO timestamp of edge creation

  // Issue #681 — edge confidence + reinforcement (PR 1/3: schema + primitive only).
  // Both fields are optional so existing edges without confidence still validate.
  // Treat a missing `confidence` as 1.0 (legacy behavior) at read sites.
  // PR 2/3 wires the maintenance decay job; PR 3/3 weights PageRank traversal by confidence.
  confidence?: number; // [0, 1]; missing = 1.0
  lastReinforcedAt?: string; // ISO timestamp of most recent reinforcement
}

export interface GraphConfig {
  multiGraphMemoryEnabled: boolean;
  entityGraphEnabled: boolean;
  timeGraphEnabled: boolean;
  causalGraphEnabled: boolean;
  maxGraphTraversalSteps: number;
  graphActivationDecay: number;
  maxEntityGraphEdgesPerMemory: number;
  graphLateralInhibitionEnabled: boolean;
  graphLateralInhibitionBeta: number;
  graphLateralInhibitionTopM: number;
}

// Causal signal phrases — order matters (most specific first)
export const CAUSAL_PHRASES = [
  "as a result",
  "led to",
  "because of",
  "therefore",
  "caused",
  "because",
];

export function graphsDir(memoryDir: string): string {
  return path.join(memoryDir, "state", "graphs");
}

export function graphFilePath(memoryDir: string, type: GraphType): string {
  return path.join(graphsDir(memoryDir), `${type}.jsonl`);
}

export async function ensureGraphsDir(memoryDir: string): Promise<void> {
  await mkdir(graphsDir(memoryDir), { recursive: true });
}

export async function appendEdge(memoryDir: string, edge: GraphEdge): Promise<void> {
  await ensureGraphsDir(memoryDir);
  const line = JSON.stringify(edge) + "\n";
  await appendFile(graphFilePath(memoryDir, edge.type), line, "utf8");
}

/**
 * Read all edges of a given type from the JSONL file.
 * Returns [] if the file doesn't exist or is corrupt (fail-open).
 */
export async function readEdges(memoryDir: string, type: GraphType): Promise<GraphEdge[]> {
  const filePath = graphFilePath(memoryDir, type);
  try {
    const raw = await readFile(filePath, "utf8");
    const edges: GraphEdge[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        edges.push(JSON.parse(trimmed) as GraphEdge);
      } catch {
        // skip corrupt lines
      }
    }
    return edges;
  } catch {
    return [];
  }
}

/**
 * Read edges from all enabled graph types.
 */
export async function readAllEdges(
  memoryDir: string,
  config: Pick<GraphConfig, "entityGraphEnabled" | "timeGraphEnabled" | "causalGraphEnabled">,
): Promise<GraphEdge[]> {
  const parts: GraphEdge[][] = await Promise.all([
    config.entityGraphEnabled ? readEdges(memoryDir, "entity") : Promise.resolve([]),
    config.timeGraphEnabled ? readEdges(memoryDir, "time") : Promise.resolve([]),
    config.causalGraphEnabled ? readEdges(memoryDir, "causal") : Promise.resolve([]),
  ]);
  return parts.flat();
}

export interface GraphHealthFileStats {
  type: GraphType;
  filePath: string;
  exists: boolean;
  totalLines: number;
  validEdges: number;
  corruptLines: number;
  uniqueNodes: number;
}

export interface GraphHealthReport {
  generatedAt: string;
  enabledTypes: GraphType[];
  totals: {
    totalLines: number;
    validEdges: number;
    corruptLines: number;
    uniqueNodes: number;
  };
  files: GraphHealthFileStats[];
  repairGuidance?: string[];
}

function isValidGraphEdge(raw: unknown, expectedType: GraphType): raw is GraphEdge {
  if (!raw || typeof raw !== "object") return false;
  const edge = raw as Record<string, unknown>;
  return (
    edge.type === expectedType &&
    typeof edge.from === "string" && edge.from.length > 0 &&
    typeof edge.to === "string" && edge.to.length > 0 &&
    typeof edge.weight === "number" && Number.isFinite(edge.weight) &&
    typeof edge.label === "string" &&
    typeof edge.ts === "string"
  );
}

export async function analyzeGraphHealth(
  memoryDir: string,
  options?: {
    entityGraphEnabled?: boolean;
    timeGraphEnabled?: boolean;
    causalGraphEnabled?: boolean;
    includeRepairGuidance?: boolean;
  },
): Promise<GraphHealthReport> {
  const enabledTypes: GraphType[] = [];
  if (options?.entityGraphEnabled !== false) enabledTypes.push("entity");
  if (options?.timeGraphEnabled !== false) enabledTypes.push("time");
  if (options?.causalGraphEnabled !== false) enabledTypes.push("causal");

  const files: GraphHealthFileStats[] = [];
  const globalNodes = new Set<string>();

  for (const type of enabledTypes) {
    const filePath = graphFilePath(memoryDir, type);
    let exists = true;
    let totalLines = 0;
    let validEdges = 0;
    let corruptLines = 0;
    const nodes = new Set<string>();

    try {
      const raw = await readFile(filePath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        totalLines += 1;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!isValidGraphEdge(parsed, type)) {
            corruptLines += 1;
            continue;
          }
          validEdges += 1;
          nodes.add(parsed.from);
          nodes.add(parsed.to);
          globalNodes.add(parsed.from);
          globalNodes.add(parsed.to);
        } catch {
          corruptLines += 1;
        }
      }
    } catch {
      exists = false;
    }

    files.push({
      type,
      filePath,
      exists,
      totalLines,
      validEdges,
      corruptLines,
      uniqueNodes: nodes.size,
    });
  }

  const totals = files.reduce(
    (acc, item) => {
      acc.totalLines += item.totalLines;
      acc.validEdges += item.validEdges;
      acc.corruptLines += item.corruptLines;
      return acc;
    },
    {
      totalLines: 0,
      validEdges: 0,
      corruptLines: 0,
      uniqueNodes: globalNodes.size,
    },
  );
  totals.uniqueNodes = globalNodes.size;

  const report: GraphHealthReport = {
    generatedAt: new Date().toISOString(),
    enabledTypes,
    totals,
    files,
  };

  if (options?.includeRepairGuidance === true) {
    const guidance: string[] = [];
    if (totals.corruptLines > 0) {
      guidance.push("Corrupt graph lines detected: back up memory/state/graphs, then rebuild graphs from clean memory replay/extraction runs.");
    }
    if (totals.validEdges === 0) {
      guidance.push("No valid edges detected yet: run normal extraction traffic (or replay ingestion) to seed graph files.");
    }
    if (guidance.length > 0) report.repairGuidance = guidance;
  }

  return report;
}

/**
 * Detect causal signal phrases in text. Returns the first matched phrase, or null.
 */
export function detectCausalPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of CAUSAL_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * GraphIndex — builds and updates the three memory graphs.
 *
 * Usage (orchestrator):
 *   this.graphIndex = new GraphIndex(config.memoryDir, config);
 *
 *   // After each memory write:
 *   await this.graphIndex.onMemoryWritten(memoryPath, frontmatter, threadId, recentInThread);
 */
export class GraphIndex {
  private readonly memoryDir: string;
  private readonly cfg: GraphConfig;

  // Cache for readAllEdges() result.  With 30k+ entity edges (6 MB JSONL) the
  // file read + JSON parse takes 2-4 s per call.  This instance-level cache
  // eliminates that overhead on every spreadingActivation() call; it is
  // invalidated (set to null) in onMemoryWritten() so new edges appear promptly.
  private edgeCache: { allEdges: GraphEdge[]; loadedAt: number } | null = null;
  private static readonly EDGE_CACHE_TTL_MS = 300_000; // 5 minutes

  constructor(memoryDir: string, cfg: GraphConfig) {
    this.memoryDir = memoryDir;
    this.cfg = cfg;
  }

  /** Clear the edge cache so the next spreadingActivation() re-reads from disk.
   *  Call after any code path that appends edges outside of onMemoryWritten(). */
  invalidateEdgeCache(): void {
    this.edgeCache = null;
  }

  private async loadEdgesCached(): Promise<GraphEdge[]> {
    if (
      this.edgeCache &&
      Date.now() - this.edgeCache.loadedAt < GraphIndex.EDGE_CACHE_TTL_MS
    ) {
      return this.edgeCache.allEdges;
    }
    const allEdges = await readAllEdges(this.memoryDir, {
      entityGraphEnabled: this.cfg.entityGraphEnabled,
      timeGraphEnabled: this.cfg.timeGraphEnabled,
      causalGraphEnabled: this.cfg.causalGraphEnabled,
    });
    this.edgeCache = { allEdges, loadedAt: Date.now() };
    return allEdges;
  }

  /**
   * Called after a memory is written to disk.
   *
   * @param memoryPath - relative path from memoryDir (e.g. "facts/2026-02-22/abc.md")
   * @param entityRef  - entityRef frontmatter field (if any)
   * @param content    - full memory text (for causal detection)
   * @param created    - ISO timestamp of this memory
   * @param threadId   - current thread ID (for time graph)
   * @param recentInThread - paths of the N most-recent memories in this thread (for time graph)
   * @param entitySiblings - paths of other memories that share the same entityRef (for entity graph)
   */
  async onMemoryWritten(opts: {
    memoryPath: string;
    entityRef?: string;
    content: string;
    created: string;
    threadId?: string;
    recentInThread?: string[];
    entitySiblings?: string[];
    causalPredecessor?: string;
  }): Promise<void> {
    if (!this.cfg.multiGraphMemoryEnabled) return;
    const ts = new Date().toISOString();

    try {
      // Entity graph
      if (this.cfg.entityGraphEnabled && opts.entityRef && opts.entitySiblings?.length) {
        const siblings = opts.entitySiblings.slice(0, this.cfg.maxEntityGraphEdgesPerMemory);
        for (const sibling of siblings) {
          await appendEdge(this.memoryDir, {
            from: opts.memoryPath,
            to: sibling,
            type: "entity",
            weight: 1.0,
            label: opts.entityRef,
            ts,
          });
        }
      }

      // Time graph — link to most recent memory in same thread
      if (this.cfg.timeGraphEnabled && opts.threadId && opts.recentInThread?.length) {
        const predecessor = opts.recentInThread[opts.recentInThread.length - 1];
        if (predecessor && predecessor !== opts.memoryPath) {
          await appendEdge(this.memoryDir, {
            from: predecessor,
            to: opts.memoryPath,
            type: "time",
            weight: 1.0,
            label: opts.threadId,
            ts,
          });
        }
      }

      // Causal graph
      if (this.cfg.causalGraphEnabled && opts.causalPredecessor) {
        const phrase = detectCausalPhrase(opts.content);
        if (phrase) {
          await appendEdge(this.memoryDir, {
            from: opts.causalPredecessor,
            to: opts.memoryPath,
            type: "causal",
            weight: 1.0,
            label: phrase,
            ts,
          });
        }
      }
    } catch (err) {
      // Fail-open: graph write errors must never surface to caller
      const { log } = await import("./logger.js");
      log.warn(`[graph] onMemoryWritten error: ${err}`);
    } finally {
      // Invalidate edge cache so spreadingActivation() picks up new edges.
      // In `finally` so the cache is cleared even on partial write failure.
      this.edgeCache = null;
    }
  }

  /**
   * Spreading activation BFS (SYNAPSE-inspired).
   *
   * Starting from `seeds`, traverse the combined graph for up to `maxSteps` hops.
   * Each candidate gets an activation score = edge.weight × decay^hop.
   * Returns top-N candidate paths sorted by descending activation score.
   *
   * @param seeds   - initial memory paths to expand from (e.g. QMD top results)
   * @param maxSteps - max BFS hops (from config: maxGraphTraversalSteps)
   * @returns Array of {path, score} sorted descending, not including seed paths
   */
  async spreadingActivation(
    seeds: string[],
    maxSteps?: number,
  ): Promise<Array<{
    path: string;
    score: number;
    seed: string;
    hopDepth: number;
    decayedWeight: number;
    graphType: "entity" | "time" | "causal";
  }>> {
    if (!this.cfg.multiGraphMemoryEnabled) return [];
    const steps = maxSteps ?? this.cfg.maxGraphTraversalSteps;
    const decay = this.cfg.graphActivationDecay;

    try {
      const allEdges = await this.loadEdgesCached();

      // Build adjacency index: from → edges, to → edges (bidirectional for entity/time, directional for causal)
      const adj = new Map<string, GraphEdge[]>();
      for (const edge of allEdges) {
        if (!adj.has(edge.from)) adj.set(edge.from, []);
        adj.get(edge.from)!.push(edge);
        // Entity and time edges are bidirectional
        if (edge.type !== "causal") {
          if (!adj.has(edge.to)) adj.set(edge.to, []);
          adj.get(edge.to)!.push({ ...edge, from: edge.to, to: edge.from });
        }
      }

      const seedSet = new Set(seeds);
      const scores = new Map<string, number>(); // candidate path → accumulated activation score
      const provenance = new Map<
        string,
        { seed: string; hopDepth: number; decayedWeight: number; graphType: "entity" | "time" | "causal" }
      >();
      const visited = new Set<string>(seeds);

      // BFS queue: [nodePath, hop, seedPath]
      const queue: Array<[string, number, string]> = seeds.map((s) => [s, 0, s]);

      while (queue.length > 0) {
        const [node, hop, sourceSeed] = queue.shift()!;
        if (hop >= steps) continue;

        const edges = adj.get(node) ?? [];
        for (const edge of edges) {
          const neighbor = edge.to === node ? edge.from : edge.to;
          const score = edge.weight * Math.pow(decay, hop + 1);

          if (!seedSet.has(neighbor)) {
            const existing = scores.get(neighbor) ?? 0;
            scores.set(neighbor, existing + score);

            const prev = provenance.get(neighbor);
            if (
              !prev ||
              hop + 1 < prev.hopDepth ||
              (hop + 1 === prev.hopDepth && score > prev.decayedWeight)
            ) {
              provenance.set(neighbor, {
                seed: sourceSeed,
                hopDepth: hop + 1,
                decayedWeight: score,
                graphType: edge.type,
              });
            }
          }

          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push([neighbor, hop + 1, sourceSeed]);
          }
        }
      }

      // Apply lateral inhibition if enabled (Synapse-inspired competitive suppression)
      if (this.cfg.graphLateralInhibitionEnabled && scores.size > 1) {
        const inhibited = applyLateralInhibition(scores, {
          beta: this.cfg.graphLateralInhibitionBeta,
          topM: this.cfg.graphLateralInhibitionTopM,
        });
        for (const [k, v] of inhibited) {
          scores.set(k, v);
        }
      }

      return Array.from(scores.entries())
        .map(([p, score]) => ({
          path: p,
          score,
          seed: provenance.get(p)?.seed ?? "",
          hopDepth: provenance.get(p)?.hopDepth ?? 0,
          decayedWeight: provenance.get(p)?.decayedWeight ?? 0,
          graphType: provenance.get(p)?.graphType ?? "entity",
        }))
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      const { log } = await import("./logger.js");
      log.warn(`[graph] spreadingActivation error: ${err}`);
      return [];
    }
  }
}

/**
 * Lateral inhibition (Synapse-inspired).
 *
 * For each node, the top-M higher-activation competitors exert inhibition
 * proportional to their activation difference. Output is clamped to [0, ∞).
 *
 * No sigmoid is applied here — downstream `normalizeGraphActivationScore`
 * already applies x/(1+x) soft squash, so adding a sigmoid would double-
 * normalize and cap graph influence at ~50%.
 *
 * Formula: u_hat_i = max(0, u_i - beta * sum_{k in top-M where u_k > u_i}(u_k - u_i))
 *
 * When beta=0 or topM=0, returns original scores unchanged (no-op).
 */
export function applyLateralInhibition(
  scores: Map<string, number>,
  opts: { beta: number; topM: number },
): Map<string, number> {
  const { beta, topM } = opts;
  if (beta === 0 || topM === 0) return new Map(scores);

  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const topCompetitors = sorted.slice(0, topM);

  const result = new Map<string, number>();
  for (const [node, u] of scores) {
    let inhibition = 0;
    for (const [, uK] of topCompetitors) {
      if (uK > u) {
        inhibition += uK - u;
      }
    }
    result.set(node, Math.max(0, u - beta * inhibition));
  }

  return result;
}
