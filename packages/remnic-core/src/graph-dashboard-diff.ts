import type { GraphEdge } from "./graph.js";
import { graphEdgeKey } from "./graph-dashboard-key.js";
import type { GraphSnapshot } from "./graph-dashboard-parser.js";

export interface GraphPatch {
  addedNodes: string[];
  removedNodes: string[];
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
}

export function diffGraphSnapshots(previous: GraphSnapshot, next: GraphSnapshot): GraphPatch {
  const prevNodeSet = new Set(previous.nodes.map((node) => node.id));
  const nextNodeSet = new Set(next.nodes.map((node) => node.id));
  const prevEdges = new Map(previous.edges.map((edge) => [graphEdgeKey(edge), edge]));
  const nextEdges = new Map(next.edges.map((edge) => [graphEdgeKey(edge), edge]));

  const addedNodes = [...nextNodeSet].filter((id) => !prevNodeSet.has(id)).sort((a, b) => a.localeCompare(b));
  const removedNodes = [...prevNodeSet].filter((id) => !nextNodeSet.has(id)).sort((a, b) => a.localeCompare(b));
  const addedEdges = [...nextEdges.entries()]
    .filter(([key]) => !prevEdges.has(key))
    .map(([, edge]) => edge)
    .sort((a, b) => a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const removedEdges = [...prevEdges.entries()]
    .filter(([key]) => !nextEdges.has(key))
    .map(([, edge]) => edge)
    .sort((a, b) => a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return {
    addedNodes,
    removedNodes,
    addedEdges,
    removedEdges,
  };
}
