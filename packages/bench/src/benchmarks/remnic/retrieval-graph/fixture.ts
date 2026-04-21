/**
 * Synthetic multi-hop fixture for the retrieval-graph benchmark
 * (issue #559 PR 5).
 *
 * Each case seeds PPR on a small memory pool and checks whether the
 * graph-aware tier surfaces memories that are two hops from the seed
 * via `supersedes` / `lineage` / `derived-from` / `mentions` edges
 * — memories that lexical-only recall would miss.
 *
 * The fixture is intentionally deterministic (no clock / RNG / I/O)
 * so CI runs produce byte-identical results.
 */

import type { MemoryEdgeSource } from "@remnic/core";

export interface GraphBenchCase {
  id: string;
  title: string;
  description: string;
  memories: MemoryEdgeSource[];
  /** Memory ids to seed PPR with (typically the top lexical matches). */
  seedIds: string[];
  /**
   * The memory ids that a correct retrieval must surface. Typically
   * includes the seed(s) plus one or more multi-hop-reachable ids that
   * only graph traversal would discover.
   */
  expectedIds: string[];
}

function supersessionChain(prefix: string, length: number): MemoryEdgeSource[] {
  const out: MemoryEdgeSource[] = [];
  for (let i = 0; i < length; i++) {
    const mem: MemoryEdgeSource = { id: `${prefix}-${i}` };
    if (i > 0) mem.supersedes = `${prefix}-${i - 1}`;
    out.push(mem);
  }
  return out;
}

function lineageTree(root: string): MemoryEdgeSource[] {
  return [
    { id: root },
    { id: `${root}-child-0`, lineage: [root] },
    { id: `${root}-child-1`, lineage: [root] },
    { id: `${root}-grand-00`, lineage: [`${root}-child-0`] },
    { id: `${root}-grand-01`, lineage: [`${root}-child-0`] },
    { id: `${root}-grand-10`, lineage: [`${root}-child-1`] },
    { id: `${root}-grand-11`, lineage: [`${root}-child-1`] },
  ];
}

export const RETRIEVAL_GRAPH_FIXTURE: GraphBenchCase[] = [
  {
    id: "supersession-chain-5",
    title: "5-link supersession chain",
    description:
      "Seed the tip; graph recall should surface the whole chain because " +
      "`supersedes` edges reliably connect each generation.",
    memories: supersessionChain("chain", 5),
    seedIds: ["chain-4"],
    expectedIds: ["chain-4", "chain-3", "chain-2"],
  },
  {
    id: "lineage-tree-depth-2",
    title: "Two-level lineage tree",
    description:
      "Seed the root; graph recall should reach both children (one hop) " +
      "and at least one grandchild (two hops) via `derived-from` edges.",
    memories: lineageTree("root"),
    seedIds: ["root"],
    expectedIds: ["root", "root-child-0", "root-child-1"],
  },
  {
    id: "mentions-bridge",
    title: "Entity-bridged memories",
    description:
      "Two memories that both mention the same entity should surface " +
      "each other via the shared `mentions` edge.",
    memories: [
      { id: "m-jane-1", entityRef: "person:Jane" },
      { id: "m-jane-2", entityRef: "person:Jane" },
      { id: "m-bob", entityRef: "person:Bob" },
    ],
    seedIds: ["m-jane-1"],
    expectedIds: ["m-jane-1", "m-jane-2"],
  },
  {
    id: "mixed-multihop",
    title: "Mixed multi-hop (lineage + mentions)",
    description:
      "Seed a child; PPR should discover the grandparent via lineage AND " +
      "a sibling via a shared entity mention.",
    memories: [
      { id: "grandparent" },
      { id: "parent", lineage: ["grandparent"] },
      { id: "child-1", lineage: ["parent"], entityRef: "topic:refactor" },
      { id: "child-2", lineage: ["parent"], entityRef: "topic:refactor" },
      { id: "unrelated", entityRef: "topic:other" },
    ],
    seedIds: ["child-1"],
    expectedIds: ["child-1", "parent", "child-2"],
  },
  {
    id: "derived-from-version",
    title: "Consolidation provenance",
    description:
      "`derived_from: ['parent:3']` must connect a consolidated memory to " +
      "its parent version-snapshot source.",
    memories: [
      { id: "parent" },
      { id: "consolidated", derived_from: ["parent:3"] },
      { id: "derived-from-consolidated", derived_from: ["consolidated:1"] },
    ],
    seedIds: ["derived-from-consolidated"],
    expectedIds: ["derived-from-consolidated", "consolidated", "parent"],
  },
  {
    id: "lexical-only-miss",
    title: "Lexical-only recall misses indirect hits",
    description:
      "A memory with zero textual overlap with the query can still be " +
      "reached through graph edges; this case checks PPR surfaces it.",
    memories: [
      { id: "user-question", entityRef: "topic:rate-limit" },
      {
        id: "planner-decision",
        entityRef: "topic:rate-limit",
        lineage: ["user-question"],
      },
      {
        id: "implementation-note",
        lineage: ["planner-decision"],
      },
      { id: "irrelevant-1", entityRef: "topic:cache" },
      { id: "irrelevant-2", entityRef: "topic:deploy" },
    ],
    seedIds: ["implementation-note"],
    expectedIds: ["implementation-note", "planner-decision", "user-question"],
  },
  {
    id: "authored-by-cluster",
    title: "Authored-by clustering",
    description:
      "Two memories authored by the same agent should cluster together " +
      "through their shared `agent:*` node.",
    memories: [
      { id: "m-a", content: "[Source: agent=planner, ts=2026-01-01T00:00:00Z]" },
      { id: "m-b", content: "[Source: agent=planner, ts=2026-01-02T00:00:00Z]" },
      { id: "m-c", content: "[Source: agent=extractor]" },
    ],
    seedIds: ["m-a"],
    expectedIds: ["m-a", "m-b"],
  },
];

export const RETRIEVAL_GRAPH_SMOKE_FIXTURE: GraphBenchCase[] =
  RETRIEVAL_GRAPH_FIXTURE.slice(0, 3);
