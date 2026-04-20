import assert from "node:assert/strict";
import test from "node:test";

import {
  type EdgeType,
  type NodeType,
  type QueryGraphResult,
  type RemnicGraph,
  type RemnicGraphEdge,
  type RemnicGraphNode,
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
