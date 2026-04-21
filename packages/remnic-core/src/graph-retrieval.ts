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

// ---------------------------------------------------------------------------
// Edge extraction (issue #559, PR 2 of 5)
// ---------------------------------------------------------------------------

/**
 * Minimum fields the edge extractor reads from a memory record. Structural
 * typing is used so callers can pass any subset of `MemoryFrontmatter`
 * (including richer loaded memories) without a cast.
 *
 * All reference fields are optional — memories written before earlier slices
 * landed will simply contribute no edges for those dimensions.
 */
export interface MemoryEdgeSource {
  /** Stable identifier for the memory (typically the file path). */
  id: string;
  /** Older memory id this memory supersedes (1:1). */
  supersedes?: string;
  /** Parent memory ids this memory was derived from (lineage). */
  lineage?: string[];
  /**
   * Consolidation provenance — `"<memory-id>:<version-number>"` strings.
   * The memory-id portion before the last `:` is used as the edge target.
   */
  derived_from?: string[];
  /** Primary entity reference on the memory (e.g. `person:Jane Doe`). */
  entityRef?: string;
  /** Additional entity references (used by episodes and ledger records). */
  entityRefs?: string[];
  /** Raw memory body — scanned for inline `[Source: ...]` citation blocks. */
  content?: string;
}

/** Options controlling edge extraction. */
export interface ExtractGraphEdgesOptions {
  /**
   * When true, include edges whose `to` endpoint is not present in the
   * provided node index. Defaults to `false` — dangling edges are silently
   * skipped because PPR cannot propagate mass through a missing node.
   */
  includeDanglingEdges?: boolean;
}

/**
 * Regex that matches the `[Source: ...]` citation block emitted by
 * `source-attribution.ts`. Kept local (rather than importing) because the
 * extractor intentionally has no dependency on the citation module's mutable
 * template configuration — it only recognizes the default shape plus minor
 * whitespace / ordering variants.
 */
// Non-greedy quantifiers on classes like `[^\]\n]+?` can be polynomial on
// pathological inputs (CodeQL rule js/polynomial-redos). Using a greedy
// quantifier with a negated character class that also excludes `[` prevents
// nested-bracket inputs from forcing catastrophic backtracking, and the `\s*`
// after `Source:` is bounded by the terminal `]`.
const CITATION_REGEX = /\[Source:[ \t]*([^\]\n[]+)\]/gi;

/**
 * Parse `key=value` pairs out of a citation body. Whitespace-tolerant and
 * case-insensitive: keys are normalized to lowercase so callers can do
 * `fields.agent` without worrying about `[Source: Agent=...]` variants.
 */
function parseCitationFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawPart of body.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * Strip the trailing `:<version>` from a `derived_from` entry. Returns the
 * original string if no colon is present. We intentionally use `lastIndexOf`
 * because memory ids may themselves contain colons (e.g. entity-prefixed
 * ids), but the version suffix — when present — is always the final
 * `:<digits>` segment.
 */
function stripDerivedFromVersion(ref: string): string {
  const colon = ref.lastIndexOf(":");
  if (colon < 0) return ref;
  const tail = ref.slice(colon + 1);
  if (tail.length === 0) return ref.slice(0, colon);
  // Only strip when the tail is purely numeric; otherwise keep the full ref.
  if (/^\d+$/.test(tail)) return ref.slice(0, colon);
  return ref;
}

/**
 * Extract retrieval-graph edges from a collection of memories.
 *
 * Pure function — no I/O, no config access, no time-based side effects.
 * Given the same inputs, always produces the same edges in the same order
 * so dedup downstream is deterministic.
 *
 * Source → target semantics by edge type:
 *
 *   - `supersedes`:    memory → older memory (from `supersedes` field).
 *   - `derived-from`:  memory → each parent in `lineage` OR `derived_from`.
 *   - `mentions`:      memory → each entity in `entityRef` / `entityRefs`.
 *   - `authored-by`:   memory → agent id parsed from inline `[Source: ...]`.
 *
 * `temporal-next`, `references`, `related-to`, and `concept` / `reflection`
 * node synthesis are deferred to later slices — they require either episode
 * sequencing or an abstraction synthesis pass that is out of scope for PR 2.
 *
 * @param memories     Memories to scan. Order is preserved; duplicates are
 *                     not deduped (the caller controls the input set).
 * @param options      Extraction knobs. See `ExtractGraphEdgesOptions`.
 * @returns            A `{ nodes, edges }` pair. `nodes` contains one
 *                     `memory` node per input memory plus one `entity` node
 *                     per distinct entity discovered across all mentions.
 *                     Edges reference ids in the returned node map unless
 *                     `includeDanglingEdges` is set.
 */
export function extractGraphEdges(
  memories: readonly MemoryEdgeSource[],
  options: ExtractGraphEdgesOptions = {},
): { nodes: Map<string, RemnicGraphNode>; edges: RemnicGraphEdge[] } {
  const includeDangling = options.includeDanglingEdges === true;

  const nodes = new Map<string, RemnicGraphNode>();
  const edges: RemnicGraphEdge[] = [];
  // Dedupe within this extraction pass. Key is `${from}\u0000${to}\u0000${type}`
  // — using a NUL separator avoids collisions with ids that contain `|`.
  const seenEdgeKeys = new Set<string>();

  const addNode = (id: string, type: NodeType) => {
    if (!nodes.has(id)) nodes.set(id, { id, type });
  };

  const addEdge = (from: string, to: string, type: EdgeType) => {
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${to}\u0000${type}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    edges.push({ from, to, type });
  };

  // First pass — register every memory as a node so cross-references can
  // resolve regardless of input ordering.
  for (const memory of memories) {
    if (!memory?.id) continue;
    addNode(memory.id, "memory");
  }

  // Second pass — walk each memory's relationship fields.
  for (const memory of memories) {
    if (!memory?.id) continue;
    const from = memory.id;

    // `supersedes`, `lineage`, and `derived_from` edges must point at a
    // memory node specifically — when `includeDanglingEdges` is false we
    // require the target to already be registered as a memory (never just
    // "present in the map", because an entity node may share the same id
    // as a referenced memory that did not make it into the input batch).
    const isKnownMemory = (id: string): boolean => {
      const existing = nodes.get(id);
      return existing !== undefined && existing.type === "memory";
    };

    // supersedes: memory → older memory
    if (typeof memory.supersedes === "string" && memory.supersedes) {
      const to = memory.supersedes;
      if (includeDangling || isKnownMemory(to)) {
        if (!nodes.has(to)) addNode(to, "memory");
        addEdge(from, to, "supersedes");
      }
    }

    // lineage: memory → each parent memory
    if (Array.isArray(memory.lineage)) {
      for (const parent of memory.lineage) {
        if (typeof parent !== "string" || !parent) continue;
        if (!includeDangling && !isKnownMemory(parent)) continue;
        if (!nodes.has(parent)) addNode(parent, "memory");
        addEdge(from, parent, "derived-from");
      }
    }

    // derived_from: memory → parent memory (strip `:<version>` suffix)
    if (Array.isArray(memory.derived_from)) {
      for (const raw of memory.derived_from) {
        if (typeof raw !== "string" || !raw) continue;
        const to = stripDerivedFromVersion(raw);
        if (!to) continue;
        if (!includeDangling && !isKnownMemory(to)) continue;
        if (!nodes.has(to)) addNode(to, "memory");
        addEdge(from, to, "derived-from");
      }
    }

    // entityRef / entityRefs: memory → entity (always register entity node)
    const entitySet = new Set<string>();
    if (typeof memory.entityRef === "string" && memory.entityRef) {
      entitySet.add(memory.entityRef);
    }
    if (Array.isArray(memory.entityRefs)) {
      for (const ref of memory.entityRefs) {
        if (typeof ref === "string" && ref) entitySet.add(ref);
      }
    }
    for (const ref of entitySet) {
      addNode(ref, "entity");
      addEdge(from, ref, "mentions");
    }

    // Inline [Source: agent=..., ...] citations → authored-by edge.
    if (typeof memory.content === "string" && memory.content.length > 0) {
      // Reset the regex's lastIndex on each memory since it is a global regex.
      CITATION_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CITATION_REGEX.exec(memory.content)) !== null) {
        const body = match[1];
        if (!body) continue;
        const fields = parseCitationFields(body);
        const agent = fields.agent;
        if (!agent) continue;
        const agentId = `agent:${agent}`;
        addNode(agentId, "entity");
        addEdge(from, agentId, "authored-by");
      }
    }
  }

  return { nodes, edges };
}

/**
 * Build a `RemnicGraph` from a collection of memories by delegating to
 * `extractGraphEdges()`. Convenience wrapper so callers do not have to
 * re-wrap the `{ nodes, edges }` pair into the `RemnicGraph` interface.
 *
 * Pure function — no I/O. Persisting the graph (e.g. writing
 * `~/.remnic/graph.json`) is left to the caller; that decision belongs with
 * the maintenance / consolidation pass in PR 4, not the extractor.
 */
export function buildGraphFromMemories(
  memories: readonly MemoryEdgeSource[],
  options: ExtractGraphEdgesOptions = {},
): RemnicGraph {
  const { nodes, edges } = extractGraphEdges(memories, options);
  return { nodes, edges };
}
