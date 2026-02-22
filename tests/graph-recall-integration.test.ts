import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import {
  Orchestrator,
  graphPathRelativeToStorage,
  mergeGraphExpandedResults,
} from "../src/orchestrator.js";

test("mergeGraphExpandedResults deduplicates by path and keeps better score", () => {
  const primary = [
    { docid: "a", path: "/tmp/facts/a.md", snippet: "seed A", score: 0.7 },
    { docid: "b", path: "/tmp/facts/b.md", snippet: "seed B", score: 0.6 },
  ];
  const expanded = [
    { docid: "a", path: "/tmp/facts/a.md", snippet: "", score: 0.9 },
    { docid: "c", path: "/tmp/facts/c.md", snippet: "expanded C", score: 0.5 },
  ];

  const merged = mergeGraphExpandedResults(primary, expanded);
  const byPath = new Map(merged.map((m) => [m.path, m]));
  assert.equal(merged.length, 3);
  assert.equal(byPath.get("/tmp/facts/a.md")?.score, 0.9);
  assert.equal(byPath.get("/tmp/facts/a.md")?.snippet, "seed A");
  assert.equal(byPath.get("/tmp/facts/c.md")?.docid, "c");
});

test("mergeGraphExpandedResults still deduplicates when expanded list is empty", () => {
  const primary = [
    { docid: "a1", path: "/tmp/facts/a.md", snippet: "", score: 0.4 },
    { docid: "a2", path: "/tmp/facts/a.md", snippet: "seed A", score: 0.9 },
    { docid: "b1", path: "/tmp/facts/b.md", snippet: "seed B", score: 0.3 },
  ];
  const merged = mergeGraphExpandedResults(primary, []);
  assert.equal(merged.length, 2);
  const byPath = new Map(merged.map((m) => [m.path, m]));
  assert.equal(byPath.get("/tmp/facts/a.md")?.score, 0.9);
  assert.equal(byPath.get("/tmp/facts/a.md")?.snippet, "seed A");
});

test("graphPathRelativeToStorage resolves in-scope paths and rejects out-of-scope paths", () => {
  const storageDir = "/tmp/memory/default";
  assert.equal(
    graphPathRelativeToStorage(storageDir, "/tmp/memory/default/facts/2026-02-22/a.md"),
    "facts/2026-02-22/a.md",
  );
  assert.equal(
    graphPathRelativeToStorage(storageDir, "facts/2026-02-22/a.md"),
    "facts/2026-02-22/a.md",
  );
  assert.equal(graphPathRelativeToStorage(storageDir, "/tmp/memory/other/facts/a.md"), null);
});

test("recallInternal writes graph recall snapshot in graph_mode", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    recallPlannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const seedId = await orchestrator.storage.writeMemory("fact", "seed memory");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);

  const expandedId = await orchestrator.storage.writeMemory("fact", "expanded memory");
  const expandedMemory = await orchestrator.storage.getMemoryById(expandedId);
  assert.ok(expandedMemory);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: seedMemory!.frontmatter.id,
        path: seedMemory!.path,
        snippet: "seed memory",
        score: 0.9,
      },
    ],
  };
  (orchestrator as any).expandResultsViaGraph = async ({ memoryResults }: any) => ({
    merged: [
      ...memoryResults,
      {
        docid: expandedMemory!.frontmatter.id,
        path: expandedMemory!.path,
        snippet: "expanded memory",
        score: 0.8,
      },
    ],
    seedPaths: [seedMemory!.path],
    expandedPaths: [{ path: expandedMemory!.path, score: 0.8, namespace: "default" }],
  });

  const out = await (orchestrator as any).recallInternal(
    "what happened in the timeline last week",
    "session-graph",
  );
  assert.match(out, /Relevant Memories/);

  const raw = await readFile(path.join(memoryDir, "state", "last_graph_recall.json"), "utf-8");
  const snapshot = JSON.parse(raw) as {
    mode: string;
    seedCount: number;
    expandedCount: number;
  };
  assert.equal(snapshot.mode, "graph_mode");
  assert.equal(snapshot.seedCount, 1);
  assert.equal(snapshot.expandedCount, 1);
});
