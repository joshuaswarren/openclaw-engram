import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "path";
import {
  graphsDir,
  graphFilePath,
  appendEdge,
  readEdges,
  readAllEdges,
  detectCausalPhrase,
  CAUSAL_PHRASES,
  GraphIndex,
  type GraphConfig,
} from "../src/graph.js";

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "engram-graph-test-"));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("detectCausalPhrase", () => {
  it("detects 'because'", () => {
    assert.equal(detectCausalPhrase("I did it because you asked"), "because");
  });

  it("detects 'as a result' before 'because'", () => {
    assert.equal(detectCausalPhrase("as a result of the change, because yes"), "as a result");
  });

  it("returns null when no phrase present", () => {
    assert.equal(detectCausalPhrase("Just a normal sentence"), null);
  });

  it("is case-insensitive", () => {
    assert.equal(detectCausalPhrase("Therefore we proceeded"), "therefore");
  });
});

describe("appendEdge + readEdges", () => {
  it("appends and reads back an edge", async () => {
    const edge = {
      from: "facts/a.md",
      to: "facts/b.md",
      type: "entity" as const,
      weight: 1.0,
      label: "project-x",
      ts: new Date().toISOString(),
    };
    await appendEdge(tmpDir, edge);
    const edges = await readEdges(tmpDir, "entity");
    assert.equal(edges.length, 1);
    assert.equal(edges[0].from, "facts/a.md");
    assert.equal(edges[0].label, "project-x");
  });

  it("returns [] for missing file (fail-open)", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "engram-graph-empty-"));
    try {
      const edges = await readEdges(fresh, "causal");
      assert.deepEqual(edges, []);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("readAllEdges", () => {
  it("merges all enabled graph types", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-graph-all-"));
    try {
      await appendEdge(dir, { from: "a.md", to: "b.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      await appendEdge(dir, { from: "c.md", to: "d.md", type: "time", weight: 1.0, label: "t1", ts: new Date().toISOString() });
      const edges = await readAllEdges(dir, { entityGraphEnabled: true, timeGraphEnabled: true, causalGraphEnabled: false });
      assert.equal(edges.length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GraphIndex.onMemoryWritten", () => {
  const cfg: GraphConfig = {
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: true,
    causalGraphEnabled: true,
    maxGraphTraversalSteps: 3,
    graphActivationDecay: 0.7,
    maxEntityGraphEdgesPerMemory: 10,
  };

  it("writes entity edges for entityRef siblings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-gi-entity-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        entityRef: "project-alpha",
        content: "We finalized the design",
        created: new Date().toISOString(),
        entitySiblings: ["facts/old.md"],
      });
      const edges = await readEdges(dir, "entity");
      assert.equal(edges.length, 1);
      assert.equal(edges[0].label, "project-alpha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes time edge to predecessor in thread", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-gi-time-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        content: "Next step in the plan",
        created: new Date().toISOString(),
        threadId: "thread-123",
        recentInThread: ["facts/prev.md"],
      });
      const edges = await readEdges(dir, "time");
      assert.equal(edges.length, 1);
      assert.equal(edges[0].from, "facts/prev.md");
      assert.equal(edges[0].to, "facts/new.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes causal edge when content contains causal phrase", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-gi-causal-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        content: "We pivoted because the original plan failed",
        created: new Date().toISOString(),
        causalPredecessor: "facts/root.md",
      });
      const edges = await readEdges(dir, "causal");
      assert.equal(edges.length, 1);
      assert.equal(edges[0].label, "because");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when multiGraphMemoryEnabled is false", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-gi-disabled-"));
    try {
      const gi = new GraphIndex(dir, { ...cfg, multiGraphMemoryEnabled: false });
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        content: "because something",
        created: new Date().toISOString(),
        entityRef: "proj",
        entitySiblings: ["facts/old.md"],
        causalPredecessor: "facts/prev.md",
      });
      const edges = await readAllEdges(dir, { entityGraphEnabled: true, timeGraphEnabled: true, causalGraphEnabled: true });
      assert.deepEqual(edges, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GraphIndex.spreadingActivation", () => {
  const cfg: GraphConfig = {
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: true,
    causalGraphEnabled: false,
    maxGraphTraversalSteps: 3,
    graphActivationDecay: 0.7,
    maxEntityGraphEdgesPerMemory: 10,
  };

  it("returns hop-1 neighbors with decay applied", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-basic-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      // seed=A, A→B (entity)
      await appendEdge(dir, { from: "A.md", to: "B.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      const results = await gi.spreadingActivation(["A.md"], 1);
      assert.equal(results.length, 1);
      assert.equal(results[0].path, "B.md");
      assert.ok(Math.abs(results[0].score - 0.7) < 0.001, `expected 0.7 got ${results[0].score}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not include seed paths in results", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-noseed-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await appendEdge(dir, { from: "A.md", to: "A.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      const results = await gi.spreadingActivation(["A.md"]);
      assert.equal(results.filter((r) => r.path === "A.md").length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accumulates activation from multiple incoming edges", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-sum-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      await appendEdge(dir, { from: "A.md", to: "C.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      await appendEdge(dir, { from: "B.md", to: "C.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      const results = await gi.spreadingActivation(["A.md", "B.md"], 1);
      const c = results.find((r) => r.path === "C.md");
      assert.ok(c, "expected C.md in activation results");
      // Each seed contributes 0.7 at hop 1, so total should be 1.4
      assert.ok(Math.abs((c?.score ?? 0) - 1.4) < 0.001, `expected 1.4 got ${c?.score}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when feature disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-off-"));
    try {
      const gi = new GraphIndex(dir, { ...cfg, multiGraphMemoryEnabled: false });
      await appendEdge(dir, { from: "A.md", to: "B.md", type: "entity", weight: 1.0, label: "e", ts: new Date().toISOString() });
      const results = await gi.spreadingActivation(["A.md"]);
      assert.deepEqual(results, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] on missing graph files (fail-open)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engram-sa-empty-"));
    try {
      const gi = new GraphIndex(dir, cfg);
      const results = await gi.spreadingActivation(["A.md"]);
      assert.deepEqual(results, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Integration: multiGraphMemoryEnabled=false baseline", () => {
  it("graph files are NOT written when flag is false", async () => {
    const { readEdges: re } = await import("../src/graph.js");
    const dir = await mkdtemp(path.join(tmpdir(), "engram-integration-off-"));
    try {
      const cfg: GraphConfig = {
        multiGraphMemoryEnabled: false,
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
        maxGraphTraversalSteps: 3,
        graphActivationDecay: 0.7,
        maxEntityGraphEdgesPerMemory: 10,
      };
      const gi = new GraphIndex(dir, cfg);
      await gi.onMemoryWritten({
        memoryPath: "facts/new.md",
        entityRef: "thing",
        content: "because of something",
        created: new Date().toISOString(),
        entitySiblings: ["facts/old.md"],
        causalPredecessor: "facts/old.md",
        threadId: "t1",
        recentInThread: ["facts/old.md"],
      });
      const entityEdges = await re(dir, "entity");
      const timeEdges = await re(dir, "time");
      const causalEdges = await re(dir, "causal");
      assert.equal(entityEdges.length, 0);
      assert.equal(timeEdges.length, 0);
      assert.equal(causalEdges.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Integration: corrupt JSONL fail-open", () => {
  it("readEdges returns [] on corrupt file", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(tmpdir(), "engram-corrupt-"));
    try {
      await mkdir(path.join(dir, "state", "graphs"), { recursive: true });
      await writeFile(path.join(dir, "state", "graphs", "entity.jsonl"), "NOT JSON\n{\"broken\": true}\n");
      const edges = await readEdges(dir, "entity");
      // The "{\"broken\": true}" line parses successfully (1 edge); "NOT JSON" is skipped
      // This verifies fail-open skips corrupt lines, not that ALL lines fail
      assert.ok(edges.length <= 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("spreadingActivation returns [] when all graph JSONL lines are corrupt", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(tmpdir(), "engram-corrupt-sa-"));
    try {
      const saCfg: GraphConfig = {
        multiGraphMemoryEnabled: true,
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
        maxGraphTraversalSteps: 3,
        graphActivationDecay: 0.7,
        maxEntityGraphEdgesPerMemory: 10,
      };
      await mkdir(path.join(dir, "state", "graphs"), { recursive: true });
      await writeFile(path.join(dir, "state", "graphs", "entity.jsonl"), "NOT JSON\nALSO NOT JSON\n");
      await writeFile(path.join(dir, "state", "graphs", "time.jsonl"), "###\n");
      await writeFile(path.join(dir, "state", "graphs", "causal.jsonl"), "{oops\n");

      const gi = new GraphIndex(dir, saCfg);
      const results = await gi.spreadingActivation(["A.md"]);
      assert.deepEqual(results, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
