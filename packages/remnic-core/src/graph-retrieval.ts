/**
 * Graph-based retrieval types (issue #559, PR 1 of 5).
 *
 * This module defines the forward-looking type contract for Remnic's
 * first-class retrieval graph (GAAMA / GAM inspired). It ships types
 * and a no-op `queryGraph()` stub only — no behavior, no I/O, and
 * no importers inside the codebase yet.
 *
 * Subsequent slices will land:
 *   - PR 2: Edge extraction from existing relationship facts + cross-memory
 *           entity references during indexing (writes `~/.remnic/graph.json`).
 *   - PR 3: Pure `personalizedPageRank()` implementation.
 *   - PR 4: Feature-flagged wiring into `retrieval.ts` behind
 *           `graphRetrievalEnabled` (default `false`).
 *   - PR 5: LoCoMo A/B bench harness + default flip decision.
 *
 * Keeping the node/edge type enums complete from PR 1 avoids type churn
 * when later slices add reflection/concept node synthesis or additional
 * edge semantics.
 */

// ---------------------------------------------------------------------------
// Node & edge type enums
// ---------------------------------------------------------------------------

/**
 * Kinds of nodes the retrieval graph can hold.
 *
 * - `memory`:     a stored memory file (the primary retrieval target).
 * - `entity`:     a named entity referenced by one or more memories.
 * - `episode`:    a temporally-bounded interaction or session grouping.
 * - `concept`:    an abstract topic / idea (forward-looking; synthesis
 *                 is out of scope for this issue, but the type is
 *                 defined here to keep later slices additive).
 * - `reflection`: an LLM-generated summary / meta-memory about other
 *                 nodes (also forward-looking, same rationale).
 */
export type NodeType =
  | "memory"
  | "entity"
  | "episode"
  | "concept"
  | "reflection";

/**
 * Kinds of edges the retrieval graph can hold.
 *
 * Edges are directed. `from` → `to` semantics:
 *
 * - `references`:    `from` contains an explicit reference to `to`
 *                    (e.g., a memory referencing another memory).
 * - `supersedes`:    `from` supersedes `to` (newer memory replaces older).
 * - `authored-by`:   `from` was authored by the entity in `to`.
 * - `mentions`:      `from` mentions the entity/concept in `to` without
 *                    a stronger relationship claim.
 * - `derived-from`:  `from` was derived from `to` (reflections,
 *                    consolidations, summaries).
 * - `temporal-next`: `from` immediately follows `to` in time (episodes).
 * - `related-to`:    generic weak relationship fallback for edges that
 *                    do not fit a stronger type.
 */
export type EdgeType =
  | "references"
  | "supersedes"
  | "authored-by"
  | "mentions"
  | "derived-from"
  | "temporal-next"
  | "related-to";

// ---------------------------------------------------------------------------
// Graph element shapes
// ---------------------------------------------------------------------------

/**
 * A single node in the retrieval graph.
 *
 * `id` is the caller-controlled stable identifier (typically a memory
 * file path, entity slug, or episode id). `weight` is an optional prior
 * importance score used as a starting bias during Personalized PageRank;
 * it is intentionally optional because most nodes default to uniform
 * priors.
 *
 * Named `RemnicGraphNode` (not `GraphNode`) to avoid colliding with the
 * unrelated `GraphEdge` in `graph.ts`, which models Multi-Graph Memory
 * (MAGMA/SYNAPSE) edges and is an incompatible shape.
 */
export interface RemnicGraphNode {
  id: string;
  type: NodeType;
  weight?: number;
}

/**
 * A directed edge between two nodes.
 *
 * `weight` is optional; when absent PPR implementations should treat
 * the edge as weight `1`. We keep weight optional rather than defaulting
 * at construction so producers can serialize a minimal edge shape.
 *
 * Named `RemnicGraphEdge` (not `GraphEdge`) to avoid colliding with the
 * unrelated `GraphEdge` in `graph.ts` (Multi-Graph Memory).
 */
export interface RemnicGraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight?: number;
}

/**
 * The retrieval graph itself.
 *
 * Nodes are held in a `Map<string, RemnicGraphNode>` keyed by `id` so
 * PPR lookups are O(1). Edges are kept as a flat array; adjacency
 * indexing is a PR-3 concern (PPR will likely build a transient
 * outgoing-adjacency map on demand).
 */
export interface RemnicGraph {
  nodes: Map<string, RemnicGraphNode>;
  edges: RemnicGraphEdge[];
}

// ---------------------------------------------------------------------------
// Query surface (stub)
// ---------------------------------------------------------------------------

/**
 * Options for `queryGraph()`.
 *
 * All fields are optional in PR 1. They are declared here so later
 * slices can add the real PPR parameters (`damping`, `iterations`,
 * `topK`, `seedWeights`, etc.) without breaking the public signature.
 */
export interface QueryGraphOptions {
  /** Number of top-ranked nodes to return. */
  topK?: number;
  /** PPR damping factor (typical range 0.1 – 0.3). */
  damping?: number;
  /** Maximum PPR iterations before convergence fallback. */
  iterations?: number;
}

/**
 * A scored node returned by `queryGraph()`.
 */
export interface RankedGraphNode {
  id: string;
  score: number;
}

/**
 * The shape returned by `queryGraph()`.
 */
export interface QueryGraphResult {
  rankedNodes: RankedGraphNode[];
}

/**
 * No-op stub. Returns an empty `rankedNodes` list for every input.
 *
 * The real implementation lands in PR 3 (Personalized PageRank). This
 * stub exists so downstream type-checked code can reference the final
 * signature starting in PR 1 without any behavior change.
 *
 * Parameters are intentionally unused; arguments are accepted only to
 * lock the public signature.
 */
export function queryGraph(
  _graph: RemnicGraph,
  _seedIds: readonly string[],
  _options?: QueryGraphOptions,
): QueryGraphResult {
  return { rankedNodes: [] };
}

// ---------------------------------------------------------------------------
// Type guards (useful for defensive construction from untyped JSON)
// ---------------------------------------------------------------------------

const NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "memory",
  "entity",
  "episode",
  "concept",
  "reflection",
]);

const EDGE_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>([
  "references",
  "supersedes",
  "authored-by",
  "mentions",
  "derived-from",
  "temporal-next",
  "related-to",
]);

/** Returns true iff `value` is a valid `NodeType`. */
export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && NODE_TYPES.has(value as NodeType);
}

/** Returns true iff `value` is a valid `EdgeType`. */
export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === "string" && EDGE_TYPES.has(value as EdgeType);
}
