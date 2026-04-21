import assert from "node:assert/strict";
import test from "node:test";

import {
  type EdgeType,
  type MemoryEdgeSource,
  type NodeType,
  type QueryGraphResult,
  type RemnicGraph,
  type RemnicGraphEdge,
  type RemnicGraphNode,
  buildGraphFromMemories,
  extractGraphEdges,
  isEdgeType,
  isNodeType,
  queryGraph,
} from "./graph-retrieval.js";

test("RemnicGraph can be constructed with nodes and edges", () => {
  const nodes = new Map<string, RemnicGraphNode>();
  nodes.set("m1", { id: "m1", type: "memory" });
  nodes.set("e1", { id: "e1", type: "entity", weight: 0.8 });

  const edges: RemnicGraphEdge[] = [
    { from: "m1", to: "e1", type: "mentions" },
    { from: "m1", to: "e1", type: "authored-by", weight: 0.5 },
  ];

  const graph: RemnicGraph = { nodes, edges };

  assert.equal(graph.nodes.size, 2);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.nodes.get("m1")?.type, "memory");
  assert.equal(graph.nodes.get("e1")?.weight, 0.8);
  assert.equal(graph.edges[0]?.type, "mentions");
  assert.equal(graph.edges[1]?.weight, 0.5);
});

test("RemnicGraphNode weight is optional (undefined is valid)", () => {
  const node: RemnicGraphNode = { id: "m1", type: "memory" };
  assert.equal(node.weight, undefined);
});

test("RemnicGraphEdge weight is optional (undefined is valid)", () => {
  const edge: RemnicGraphEdge = { from: "a", to: "b", type: "related-to" };
  assert.equal(edge.weight, undefined);
});

test("nodes can be added and retrieved after construction", () => {
  const graph: RemnicGraph = { nodes: new Map(), edges: [] };
  graph.nodes.set("mem-1", { id: "mem-1", type: "memory" });
  graph.edges.push({ from: "mem-1", to: "mem-2", type: "supersedes" });

  assert.equal(graph.nodes.size, 1);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.type, "supersedes");
});

test("queryGraph stub returns an empty ranked list for an empty graph", () => {
  const graph: RemnicGraph = { nodes: new Map(), edges: [] };
  const result: QueryGraphResult = queryGraph(graph, []);
  assert.deepEqual(result, { rankedNodes: [] });
});

test("queryGraph stub returns an empty ranked list for a populated graph", () => {
  const nodes = new Map<string, RemnicGraphNode>();
  nodes.set("m1", { id: "m1", type: "memory" });
  nodes.set("m2", { id: "m2", type: "memory" });
  const graph: RemnicGraph = {
    nodes,
    edges: [{ from: "m1", to: "m2", type: "references" }],
  };

  const result = queryGraph(graph, ["m1"], { topK: 10, damping: 0.15, iterations: 50 });
  assert.deepEqual(result.rankedNodes, []);
});

test("queryGraph stub tolerates arbitrary seed ids and options", () => {
  const graph: RemnicGraph = { nodes: new Map(), edges: [] };
  // Should not throw even when seed ids do not exist in the graph.
  const result = queryGraph(graph, ["does-not-exist", "also-missing"], {});
  assert.deepEqual(result.rankedNodes, []);
});

test("isNodeType accepts every documented node type", () => {
  const expected: NodeType[] = [
    "memory",
    "entity",
    "episode",
    "concept",
    "reflection",
  ];
  for (const t of expected) {
    assert.equal(isNodeType(t), true, `expected ${t} to be a NodeType`);
  }
});

test("isNodeType rejects unknown values", () => {
  assert.equal(isNodeType("fact"), false);
  assert.equal(isNodeType(""), false);
  assert.equal(isNodeType(null), false);
  assert.equal(isNodeType(undefined), false);
  assert.equal(isNodeType(42), false);
  assert.equal(isNodeType({ type: "memory" }), false);
});

test("isEdgeType accepts every documented edge type", () => {
  const expected: EdgeType[] = [
    "references",
    "supersedes",
    "authored-by",
    "mentions",
    "derived-from",
    "temporal-next",
    "related-to",
  ];
  for (const t of expected) {
    assert.equal(isEdgeType(t), true, `expected ${t} to be an EdgeType`);
  }
});

test("isEdgeType rejects unknown values", () => {
  assert.equal(isEdgeType("points-to"), false);
  assert.equal(isEdgeType(""), false);
  assert.equal(isEdgeType(null), false);
  assert.equal(isEdgeType(undefined), false);
  assert.equal(isEdgeType(0), false);
  assert.equal(isEdgeType({ type: "references" }), false);
});

// ---------------------------------------------------------------------------
// Edge extraction (PR 2)
// ---------------------------------------------------------------------------

test("extractGraphEdges returns empty result for empty input", () => {
  const { nodes, edges } = extractGraphEdges([]);
  assert.equal(nodes.size, 0);
  assert.equal(edges.length, 0);
});

test("extractGraphEdges registers a memory node per input", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1" },
    { id: "m2" },
    { id: "m3" },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.size, 3);
  assert.equal(nodes.get("m1")?.type, "memory");
  assert.equal(nodes.get("m2")?.type, "memory");
  assert.equal(nodes.get("m3")?.type, "memory");
  assert.equal(edges.length, 0);
});

test("extractGraphEdges produces a supersedes edge when target is known", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m-new", supersedes: "m-old" },
    { id: "m-old" },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], { from: "m-new", to: "m-old", type: "supersedes" });
});

test("extractGraphEdges skips dangling supersedes unless includeDanglingEdges is set", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m-new", supersedes: "m-missing" },
  ];
  const skipped = extractGraphEdges(memories);
  assert.equal(skipped.edges.length, 0);

  const kept = extractGraphEdges(memories, { includeDanglingEdges: true });
  assert.equal(kept.edges.length, 1);
  assert.equal(kept.edges[0]?.type, "supersedes");
  assert.equal(kept.nodes.get("m-missing")?.type, "memory");
});

test("extractGraphEdges emits derived-from edges from lineage and derived_from", () => {
  const memories: MemoryEdgeSource[] = [
    {
      id: "m-child",
      lineage: ["m-parent-1"],
      derived_from: ["m-parent-2:3", "m-parent-3"],
    },
    { id: "m-parent-1" },
    { id: "m-parent-2" },
    { id: "m-parent-3" },
  ];
  const { edges } = extractGraphEdges(memories);
  const derived = edges.filter((e) => e.type === "derived-from");
  assert.equal(derived.length, 3);
  const targets = derived.map((e) => e.to).sort();
  assert.deepEqual(targets, ["m-parent-1", "m-parent-2", "m-parent-3"]);
});

test("extractGraphEdges strips trailing :<version> only when numeric", () => {
  const memories: MemoryEdgeSource[] = [
    {
      id: "m-child",
      derived_from: ["facts/preferences.md:7", "entity:person:Jane"],
    },
    { id: "facts/preferences.md" },
    { id: "entity:person:Jane" },
  ];
  const { edges } = extractGraphEdges(memories);
  const derived = edges.filter((e) => e.type === "derived-from").map((e) => e.to).sort();
  assert.deepEqual(derived, ["entity:person:Jane", "facts/preferences.md"]);
});

test("extractGraphEdges dedupes identical edges from overlapping lineage and derived_from", () => {
  const memories: MemoryEdgeSource[] = [
    {
      id: "m-child",
      lineage: ["m-parent"],
      derived_from: ["m-parent:1", "m-parent:2"],
    },
    { id: "m-parent" },
  ];
  const { edges } = extractGraphEdges(memories);
  const derived = edges.filter((e) => e.type === "derived-from");
  assert.equal(derived.length, 1);
});

test("extractGraphEdges creates entity nodes and mentions edges from entityRef / entityRefs", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", entityRef: "person:Jane" },
    { id: "m2", entityRefs: ["person:Jane", "org:Acme"] },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.get("person:Jane")?.type, "entity");
  assert.equal(nodes.get("org:Acme")?.type, "entity");

  const mentions = edges.filter((e) => e.type === "mentions");
  assert.equal(mentions.length, 3);
  const pairs = mentions.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, [
    "m1->person:Jane",
    "m2->org:Acme",
    "m2->person:Jane",
  ]);
});

test("extractGraphEdges parses inline [Source: agent=...] blocks into authored-by edges", () => {
  const memories: MemoryEdgeSource[] = [
    {
      id: "m1",
      content: "Fact body. [Source: agent=planner, session=abc, ts=2026-04-10T14:25:07Z]",
    },
    {
      id: "m2",
      content: "Multi-citation [Source: agent=extractor] and [Source: agent=judge]",
    },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  const authored = edges.filter((e) => e.type === "authored-by");
  const pairs = authored.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, [
    "m1->agent:planner",
    "m2->agent:extractor",
    "m2->agent:judge",
  ]);
  assert.equal(nodes.get("agent:planner")?.type, "entity");
  assert.equal(nodes.get("agent:extractor")?.type, "entity");
  assert.equal(nodes.get("agent:judge")?.type, "entity");
});

test("extractGraphEdges ignores malformed citations with no agent field", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", content: "[Source: session=abc, ts=2026-01-01T00:00:00Z]" },
    { id: "m2", content: "[Source:]" },
    { id: "m3", content: "[Source: agent=]" },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.filter((e) => e.type === "authored-by").length, 0);
});

test("extractGraphEdges does not emit self-loops", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", supersedes: "m1", lineage: ["m1"], derived_from: ["m1:1"] },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.length, 0);
});

test("extractGraphEdges is deterministic across invocations", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m-a", lineage: ["m-b", "m-c"], entityRefs: ["x", "y"] },
    { id: "m-b" },
    { id: "m-c" },
    { id: "m-d", supersedes: "m-a", content: "[Source: agent=alpha]" },
  ];
  const first = extractGraphEdges(memories);
  const second = extractGraphEdges(memories);
  assert.deepEqual(first.edges, second.edges);
  assert.deepEqual([...first.nodes.keys()], [...second.nodes.keys()]);
});

test("extractGraphEdges returns a realistic 8-memory fixture end-to-end", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", entityRef: "person:Jane" },
    { id: "m2", entityRef: "person:Jane", content: "[Source: agent=extractor]" },
    { id: "m3", lineage: ["m1", "m2"], entityRefs: ["person:Jane", "org:Acme"] },
    { id: "m4", supersedes: "m3", derived_from: ["m3:1"] },
    { id: "m5", entityRef: "org:Acme", content: "[Source: agent=judge]" },
    { id: "m6", lineage: ["m4"], entityRefs: ["person:Bob"] },
    { id: "m7", derived_from: ["m6:2"] },
    { id: "m8" },
  ];
  const { nodes, edges } = extractGraphEdges(memories);

  // 8 memory nodes + 3 distinct entities + 2 distinct agents = 13 nodes.
  assert.equal(nodes.size, 13);
  const memoryNodes = [...nodes.values()].filter((n) => n.type === "memory");
  assert.equal(memoryNodes.length, 8);
  const entityNodes = [...nodes.values()].filter((n) => n.type === "entity");
  assert.equal(entityNodes.length, 5);

  // Count edges by type for clarity.
  const counts: Record<string, number> = {};
  for (const e of edges) counts[e.type] = (counts[e.type] ?? 0) + 1;
  // m4 → m3 supersedes
  assert.equal(counts["supersedes"], 1);
  // m3 lineage → m1, m2 (2); m4 derived_from m3:1 → m3 (1); m6 lineage → m4 (1);
  // m7 derived_from m6:2 → m6 (1). Total: 5 derived-from edges.
  assert.equal(counts["derived-from"], 5);
  // m1→Jane, m2→Jane, m3→Jane, m3→Acme, m5→Acme, m6→Bob = 6 mentions.
  assert.equal(counts["mentions"], 6);
  // m2 → agent:extractor; m5 → agent:judge = 2 authored-by.
  assert.equal(counts["authored-by"], 2);
});

test("buildGraphFromMemories wraps extractGraphEdges into a RemnicGraph", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", entityRef: "person:Jane" },
    { id: "m2", supersedes: "m1" },
  ];
  const graph: RemnicGraph = buildGraphFromMemories(memories);
  assert.ok(graph.nodes instanceof Map);
  assert.ok(Array.isArray(graph.edges));
  assert.equal(graph.nodes.size, 3); // m1, m2, person:Jane
  assert.equal(graph.edges.length, 2); // m1→Jane mentions, m2→m1 supersedes
});

test("extractGraphEdges rejects type mismatch: supersedes points at entity, not memory", () => {
  // memory-A carries entityRef "shared-id" (creates an entity node).
  // memory-B carries supersedes: "shared-id" — must NOT emit the edge,
  // because the only existing "shared-id" node is an entity, not a memory.
  const memories: MemoryEdgeSource[] = [
    { id: "m-A", entityRef: "shared-id" },
    { id: "m-B", supersedes: "shared-id" },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.filter((e) => e.type === "supersedes").length, 0);
  // The mention edge must still fire.
  assert.equal(edges.filter((e) => e.type === "mentions").length, 1);
});

test("extractGraphEdges type-mismatch guard applies even with includeDanglingEdges=true", () => {
  // Fresh evidence: with dangling edges enabled, the guard must still
  // reject memory → entity cross-type references. The entity node for
  // "shared-id" is created first via m-A's entityRef; m-B's supersedes
  // reference must NOT overwrite or attach to that entity node.
  const memories: MemoryEdgeSource[] = [
    { id: "m-A", entityRef: "shared-id" },
    { id: "m-B", supersedes: "shared-id", lineage: ["shared-id"] },
    { id: "m-C", derived_from: ["shared-id:1"] },
  ];
  const { nodes, edges } = extractGraphEdges(memories, { includeDanglingEdges: true });
  assert.equal(edges.filter((e) => e.type === "supersedes").length, 0);
  assert.equal(edges.filter((e) => e.type === "derived-from").length, 0);
  // The shared id remains an entity node, not promoted to memory.
  assert.equal(nodes.get("shared-id")?.type, "entity");
});

test("extractGraphEdges rejects type mismatch: derived-from points at entity, not memory", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m-A", entityRef: "shared-id" },
    { id: "m-B", lineage: ["shared-id"] },
    { id: "m-C", derived_from: ["shared-id:1"] },
  ];
  const { edges } = extractGraphEdges(memories);
  assert.equal(edges.filter((e) => e.type === "derived-from").length, 0);
});

test("extractGraphEdges drops mentions edge when target id collides with an existing memory", () => {
  // A memory with id "person:Jane" collides with a downstream entityRef
  // "person:Jane". The existing node stays a memory; the mentions edge
  // is dropped rather than retyping the node. This preserves the
  // extractor's typed-node contract.
  const memories: MemoryEdgeSource[] = [
    { id: "person:Jane" },
    { id: "m-A", entityRef: "person:Jane" },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.get("person:Jane")?.type, "memory");
  assert.equal(edges.filter((e) => e.type === "mentions").length, 0);
});

test("extractGraphEdges drops authored-by edge when agent id collides with an existing memory", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "agent:planner" },
    { id: "m-A", content: "[Source: agent=planner]" },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.get("agent:planner")?.type, "memory");
  assert.equal(edges.filter((e) => e.type === "authored-by").length, 0);
});

test("extractGraphEdges lowercases citation keys (case-insensitive match)", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1", content: "[Source: Agent=Planner, SESSION=abc]" },
    { id: "m2", content: "[source: agent=judge]" },
  ];
  const { edges } = extractGraphEdges(memories);
  const authored = edges.filter((e) => e.type === "authored-by");
  const pairs = authored.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, ["m1->agent:Planner", "m2->agent:judge"]);
});

test("extractGraphEdges skips memories with no id", () => {
  const memories: MemoryEdgeSource[] = [
    { id: "m1" },
    { id: "", supersedes: "m1" } as MemoryEdgeSource,
    { id: "m2", lineage: ["m1"] },
  ];
  const { nodes, edges } = extractGraphEdges(memories);
  assert.equal(nodes.size, 2);
  assert.ok(!nodes.has(""));
  assert.equal(edges.length, 1); // m2 → m1 derived-from only
  assert.equal(edges[0]?.type, "derived-from");
});
