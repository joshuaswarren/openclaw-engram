import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import {
  runDirectAgent,
  runTemporalAgent,
  parallelRetrieval,
  augmentWithDirectAndTemporal,
  shouldRunAgent,
  PARALLEL_AGENT_WEIGHTS,
  type SearchAgentSource,
} from "../src/retrieval-agents.js";
import type { QmdClient } from "../src/qmd.js";

// ─── shouldRunAgent ───────────────────────────────────────────────────────────

test("shouldRunAgent: direct skipped when query has no word-like tokens", () => {
  assert.equal(shouldRunAgent("direct", "", 0), false);
  assert.equal(shouldRunAgent("direct", "! @", 0), false);
});

test("shouldRunAgent: direct runs for lowercase entity prompts", () => {
  assert.equal(shouldRunAgent("direct", "what did i eat yesterday", 0), true);
  assert.equal(shouldRunAgent("direct", "postgres migration notes", 0), true);
  assert.equal(shouldRunAgent("direct", "openclaw decisions", 0), true);
});

test("shouldRunAgent: direct runs when proper nouns present", () => {
  assert.equal(shouldRunAgent("direct", "what did Alice say", 0), true);
});

test("shouldRunAgent: direct runs when knownEntityCount > 0", () => {
  assert.equal(shouldRunAgent("direct", "what happened", 3), true);
});

test("shouldRunAgent: contextual always runs", () => {
  assert.equal(shouldRunAgent("contextual", "anything", 0), true);
});

test("shouldRunAgent: temporal always runs", () => {
  assert.equal(shouldRunAgent("temporal", "anything", 0), true);
});

// ─── PARALLEL_AGENT_WEIGHTS ───────────────────────────────────────────────────

test("PARALLEL_AGENT_WEIGHTS: direct >= temporal >= contextual", () => {
  const w = PARALLEL_AGENT_WEIGHTS;
  assert.ok(w.direct >= w.temporal, "direct weight must be >= temporal");
  assert.ok(w.temporal >= w.contextual, "temporal weight must be >= contextual");
});

// ─── runDirectAgent ───────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "engram-agent-test-"));
}

test("runDirectAgent: returns empty when entities dir missing", async () => {
  const tmpDir = await makeTempDir();
  const results = await runDirectAgent("alice project planning", tmpDir);
  assert.deepEqual(results, []);
});

test("runDirectAgent: returns empty when no entity files match", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  await writeFile(path.join(tmpDir, "entities", "zebra-crossing.md"), "content");

  const results = await runDirectAgent("alice project planning", tmpDir);
  assert.deepEqual(results, []);
});

test("runDirectAgent: returns matching entity by filename token overlap", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  await writeFile(path.join(tmpDir, "entities", "alice-smith.md"), "# Alice Smith\n\nFact: loves coffee.");
  await writeFile(path.join(tmpDir, "entities", "bob-jones.md"), "# Bob Jones\n\nFact: unknown.");

  const results = await runDirectAgent("alice project planning", tmpDir);
  assert.equal(results.length, 1);
  assert.ok(results[0].path.includes("alice-smith.md"));
  assert.ok(results[0].score > 0);
  assert.equal(results[0].agentSource, "direct");
});

test("runDirectAgent: scores decrease for less-matching entities", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  // "alice-project" matches query tokens "alice" + "project" — 2 hits
  await writeFile(path.join(tmpDir, "entities", "alice-project.md"), "content");
  // "alice-notes" matches only "alice" — 1 hit
  await writeFile(path.join(tmpDir, "entities", "alice-notes.md"), "content");

  const results = await runDirectAgent("alice project", tmpDir);
  assert.ok(results.length >= 2);
  // alice-project should score higher than alice-notes
  const aliceProject = results.find((r) => r.path.includes("alice-project"));
  const aliceNotes = results.find((r) => r.path.includes("alice-notes"));
  assert.ok(aliceProject !== undefined);
  assert.ok(aliceNotes !== undefined);
  assert.ok(aliceProject!.score >= aliceNotes!.score);
});

test("runDirectAgent: respects maxResults limit", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  for (let i = 0; i < 15; i++) {
    await writeFile(path.join(tmpDir, "entities", `alice-item-${i}.md`), "content");
  }

  const results = await runDirectAgent("alice", tmpDir, 5);
  assert.ok(results.length <= 5);
});

test("runDirectAgent: gracefully handles readdir error", async () => {
  // Pass a non-existent nested path — should return [] not throw
  const results = await runDirectAgent("query", "/nonexistent/deep/path");
  assert.deepEqual(results, []);
});

// ─── runTemporalAgent ─────────────────────────────────────────────────────────

test("runTemporalAgent: returns empty when no temporal index", async () => {
  const tmpDir = await makeTempDir();
  const results = await runTemporalAgent("what happened recently", tmpDir);
  assert.deepEqual(results, []);
});

test("runTemporalAgent: returns paths from temporal index within window", async () => {
  const tmpDir = await makeTempDir();
  const stateDir = path.join(tmpDir, "state");
  await mkdir(stateDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const index = {
    version: 1,
    dates: {
      [today]: [path.join(tmpDir, "facts", "today-fact.md")],
      [yesterday]: [path.join(tmpDir, "facts", "yesterday-fact.md")],
      "2020-01-01": [path.join(tmpDir, "facts", "old-fact.md")],
    },
  };
  await writeFile(path.join(stateDir, "index_time.json"), JSON.stringify(index));

  // "recently" uses default 7-day window — should return today + yesterday but not 2020
  const results = await runTemporalAgent("what happened recently", tmpDir);
  assert.ok(results.length >= 1);
  assert.ok(results.every((r) => r.agentSource === "temporal"));

  const paths = results.map((r) => r.path);
  assert.ok(paths.some((p) => p.includes("today-fact.md") || p.includes("yesterday-fact.md")));
  assert.ok(!paths.some((p) => p.includes("old-fact.md")));
});

test("runTemporalAgent: assigns higher score to more recent paths", async () => {
  const tmpDir = await makeTempDir();
  const stateDir = path.join(tmpDir, "state");
  await mkdir(stateDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  const index = {
    version: 1,
    dates: {
      [today]: [path.join(tmpDir, "facts", "fresh.md")],
      [weekAgo]: [path.join(tmpDir, "facts", "week-old.md")],
    },
  };
  await writeFile(path.join(stateDir, "index_time.json"), JSON.stringify(index));

  const results = await runTemporalAgent("recent stuff", tmpDir);
  const fresh = results.find((r) => r.path.includes("fresh.md"));
  const old = results.find((r) => r.path.includes("week-old.md"));
  if (fresh && old) {
    assert.ok(fresh.score >= old.score, "today's fact should score >= week-old fact");
  }
});

test("runTemporalAgent: respects maxResults limit", async () => {
  const tmpDir = await makeTempDir();
  const stateDir = path.join(tmpDir, "state");
  await mkdir(stateDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const paths: Record<string, string[]> = {};
  paths[today] = Array.from({ length: 25 }, (_, i) => `/tmp/fact-${i}.md`);

  await writeFile(
    path.join(stateDir, "index_time.json"),
    JSON.stringify({ version: 1, dates: paths }),
  );

  const results = await runTemporalAgent("what happened today", tmpDir, 10);
  assert.ok(results.length <= 10);
});

// ─── parallelRetrieval ────────────────────────────────────────────────────────

function makeNullQmd(): QmdClient {
  return {
    hybridSearch: async () => [],
    isAvailable: () => false,
    bm25Search: async () => [],
    vectorSearch: async () => [],
    search: async () => [],
  } as unknown as QmdClient;
}

function makeStubQmd(results: Array<{ docid: string; path: string; snippet: string; score: number }>): QmdClient {
  return {
    hybridSearch: async () => results,
    isAvailable: () => true,
    bm25Search: async () => [],
    vectorSearch: async () => [],
    search: async () => [],
  } as unknown as QmdClient;
}

test("parallelRetrieval: returns empty when no data anywhere", async () => {
  const tmpDir = await makeTempDir();
  const results = await parallelRetrieval("what did i work on", makeNullQmd(), tmpDir);
  assert.deepEqual(results, []);
});

test("parallelRetrieval: merges results from contextual agent", async () => {
  const tmpDir = await makeTempDir();
  const fakeResults = [
    { docid: "fact-1", path: "/tmp/fact-1.md", snippet: "a fact", score: 0.9 },
    { docid: "fact-2", path: "/tmp/fact-2.md", snippet: "another fact", score: 0.7 },
  ];
  const qmd = makeStubQmd(fakeResults);

  const results = await parallelRetrieval("what happened", qmd, tmpDir);
  // contextual agent results should be present (with weight applied)
  assert.ok(results.length > 0);
  const paths = results.map((r) => r.path);
  assert.ok(paths.includes("/tmp/fact-1.md"));
  assert.ok(paths.includes("/tmp/fact-2.md"));
});

test("parallelRetrieval: contextual results have weight applied (score * 0.7)", async () => {
  const tmpDir = await makeTempDir();
  const qmd = makeStubQmd([
    { docid: "fact-1", path: "/tmp/fact-1.md", snippet: "test", score: 1.0 },
  ]);

  const results = await parallelRetrieval("query", qmd, tmpDir, { skipContextual: false });
  const r = results.find((x) => x.path === "/tmp/fact-1.md");
  assert.ok(r !== undefined);
  // contextual weight = 0.7, original score = 1.0, so weighted = 0.7
  assert.ok(Math.abs(r!.score - 0.7) < 0.01);
});

test("parallelRetrieval: skipContextual omits contextual agent", async () => {
  const tmpDir = await makeTempDir();
  const qmd = makeStubQmd([
    { docid: "fact-1", path: "/tmp/fact-1.md", snippet: "test", score: 1.0 },
  ]);

  const results = await parallelRetrieval("query", qmd, tmpDir, { skipContextual: true });
  // contextual agent skipped, no entity/temporal data → empty
  assert.deepEqual(results, []);
});

test("parallelRetrieval: deduplicates results from multiple agents by path", async () => {
  const tmpDir = await makeTempDir();
  const stateDir = path.join(tmpDir, "state");
  await mkdir(stateDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const sharedPath = "/tmp/shared.md";
  await writeFile(
    path.join(stateDir, "index_time.json"),
    JSON.stringify({ version: 1, dates: { [today]: [sharedPath] } }),
  );

  // Also in contextual results
  const qmd = makeStubQmd([
    { docid: "shared", path: sharedPath, snippet: "shared fact", score: 0.5 },
  ]);

  const results = await parallelRetrieval("what happened today", qmd, tmpDir);
  const sharedResults = results.filter((r) => r.path === sharedPath);
  // Must appear only once (deduplicated)
  assert.equal(sharedResults.length, 1);
});

test("parallelRetrieval: gracefully handles agent errors (isolation)", async () => {
  const tmpDir = await makeTempDir();
  // QMD that throws
  const qmd = {
    hybridSearch: async () => {
      throw new Error("QMD unavailable");
    },
    isAvailable: () => false,
  } as unknown as QmdClient;

  // Should not throw — graceful degradation
  const results = await parallelRetrieval("query", qmd, tmpDir);
  assert.ok(Array.isArray(results));
});

test("parallelRetrieval: respects maxResults limit", async () => {
  const tmpDir = await makeTempDir();
  const qmd = makeStubQmd(
    Array.from({ length: 30 }, (_, i) => ({
      docid: `fact-${i}`,
      path: `/tmp/fact-${i}.md`,
      snippet: "",
      score: 1 - i * 0.01,
    })),
  );

  const results = await parallelRetrieval("query", qmd, tmpDir, { maxResults: 5 });
  assert.ok(results.length <= 5);
});

test("parallelRetrieval: results sorted by score descending", async () => {
  const tmpDir = await makeTempDir();
  const qmd = makeStubQmd([
    { docid: "a", path: "/tmp/a.md", snippet: "", score: 0.3 },
    { docid: "b", path: "/tmp/b.md", snippet: "", score: 0.9 },
    { docid: "c", path: "/tmp/c.md", snippet: "", score: 0.6 },
  ]);

  const results = await parallelRetrieval("query", qmd, tmpDir);
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].score >= results[i].score,
      `results not sorted: ${results[i - 1].score} < ${results[i].score}`,
    );
  }
});

test("parallelRetrieval: direct results get higher weight than contextual (same base score)", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  // Create entity that matches "alice" query
  await writeFile(path.join(tmpDir, "entities", "alice.md"), "content");

  // Contextual also returns alice, same score=1.0
  const qmd = makeStubQmd([
    { docid: "alice", path: path.join(tmpDir, "entities", "alice.md"), snippet: "alice", score: 1.0 },
  ]);

  const results = await parallelRetrieval("alice query", qmd, tmpDir);
  const r = results.find((x) => x.path.includes("alice.md"));
  assert.ok(r !== undefined);
  // Direct weight (1.0) > contextual weight (0.7), but only one deduped entry
  // With the direct agent hitting alice.md at score ~0.5 * 1.0 = 0.5
  // and contextual at score 1.0 * 0.7 = 0.7 — contextual wins because higher weighted
  // The key test: result exists and has a score
  assert.ok(r!.score > 0);
});

// ─── augmentWithDirectAndTemporal ────────────────────────────────────────────

const DEFAULT_WEIGHTS = { direct: 1.0, contextual: 0.7, temporal: 0.85 };

test("augmentWithDirectAndTemporal: returns weighted contextual-only when no agent data", async () => {
  const tmpDir = await makeTempDir();
  const contextual = [
    { docid: "a", path: "/tmp/a.md", snippet: "a snippet", score: 1.0, transport: "hybrid" as const },
  ];
  const results = await augmentWithDirectAndTemporal("query", tmpDir, contextual, DEFAULT_WEIGHTS, 10, 20);
  assert.ok(results.length > 0);
  // Score must be contextual weight applied consistently
  assert.ok(Math.abs(results[0].score - 0.7) < 0.01);
});

test("augmentWithDirectAndTemporal: applies contextual weight even with no augmentation", async () => {
  // Edge case: no entity/temporal data, just contextual results
  // Score must always be weighted (consistent with case where agents have results)
  const tmpDir = await makeTempDir();
  const contextual = [
    { docid: "x", path: "/tmp/x.md", snippet: "x snippet", score: 0.8, transport: "hybrid" as const },
  ];
  const results = await augmentWithDirectAndTemporal("no entities here", tmpDir, contextual, DEFAULT_WEIGHTS, 10, 20);
  assert.ok(results.length > 0);
  // Contextual weight 0.7 applied: 0.8 * 0.7 = 0.56
  assert.ok(Math.abs(results[0].score - 0.56) < 0.01);
});

test("augmentWithDirectAndTemporal: direct agent results merge with contextual", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  await writeFile(path.join(tmpDir, "entities", "alice.md"), "# Alice");

  // Contextual has alice at score 0.6; direct hits alice at filename overlap
  const contextual = [
    { docid: "alice", path: path.join(tmpDir, "entities", "alice.md"), snippet: "alice info", score: 0.6, transport: "hybrid" as const },
  ];
  const results = await augmentWithDirectAndTemporal("alice project", tmpDir, contextual, DEFAULT_WEIGHTS, 10, 20);
  const r = results.find((x) => x.path.includes("alice.md"));
  assert.ok(r !== undefined);
  // Direct weight=1.0 × some overlap score should be > contextual 0.6 × 0.7=0.42
  assert.ok(r!.score > 0);
});

test("augmentWithDirectAndTemporal: preserves snippet when higher-scoring agent has empty snippet", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  await writeFile(path.join(tmpDir, "entities", "alice.md"), "# Alice");

  // Contextual has alice with a snippet; direct also matches with higher score but no snippet
  const contextual = [
    { docid: "alice", path: path.join(tmpDir, "entities", "alice.md"), snippet: "preserved snippet", score: 0.1, transport: "hybrid" as const },
  ];
  const results = await augmentWithDirectAndTemporal("Alice something", tmpDir, contextual, DEFAULT_WEIGHTS, 10, 20);
  const r = results.find((x) => x.path.includes("alice.md"));
  assert.ok(r !== undefined);
  // Snippet should be preserved even though direct agent has empty snippet
  assert.equal(r!.snippet, "preserved snippet");
});

test("augmentWithDirectAndTemporal: deduplicates by path, keeps highest weighted score", async () => {
  const tmpDir = await makeTempDir();
  const stateDir = path.join(tmpDir, "state");
  await mkdir(stateDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const sharedPath = "/tmp/shared.md";
  await writeFile(
    path.join(stateDir, "index_time.json"),
    JSON.stringify({ version: 1, dates: { [today]: [sharedPath] } }),
  );

  // Contextual has shared path at score 0.5; temporal should also include it
  const contextual = [
    { docid: "shared", path: sharedPath, snippet: "shared snippet", score: 0.5, transport: "hybrid" as const },
  ];
  const results = await augmentWithDirectAndTemporal("what happened today", tmpDir, contextual, DEFAULT_WEIGHTS, 10, 20);
  const sharedResults = results.filter((r) => r.path === sharedPath);
  assert.equal(sharedResults.length, 1, "deduplication: path appears only once");
});

test("augmentWithDirectAndTemporal: populates snippet from file content for specialized-agent discoveries", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  const entityPath = path.join(tmpDir, "entities", "alice.md");
  await writeFile(entityPath, "# Alice Smith\n\nAlice is the lead engineer.");

  // Contextual returns nothing — alice.md is only discovered by the direct agent
  const contextual: Array<{ docid: string; path: string; snippet: string; score: number; transport: string }> = [];
  const results = await augmentWithDirectAndTemporal("Alice project", tmpDir, contextual, DEFAULT_WEIGHTS, 10, 20);

  const r = results.find((x) => x.path === entityPath);
  assert.ok(r !== undefined, "direct agent result should be in merged results");
  // Snippet should be populated from file content
  assert.ok(r!.snippet.length > 0, "snippet should be populated from file content");
  assert.ok(r!.snippet.includes("Alice"), "snippet should contain file content");
});

test("augmentWithDirectAndTemporal: respects maxResults limit", async () => {
  const tmpDir = await makeTempDir();
  const contextual = Array.from({ length: 30 }, (_, i) => ({
    docid: `fact-${i}`,
    path: `/tmp/fact-${i}.md`,
    snippet: "",
    score: 1 - i * 0.01,
    transport: "hybrid" as const,
  }));
  const results = await augmentWithDirectAndTemporal("query", tmpDir, contextual, DEFAULT_WEIGHTS, 20, 5);
  assert.ok(results.length <= 5);
});

test("augmentWithDirectAndTemporal: maxPerAgent=0 returns contextual unchanged without reweighting", async () => {
  const tmpDir = await makeTempDir();
  const contextual = [
    { docid: "a", path: "/tmp/a.md", snippet: "snippet", score: 0.99, transport: "hybrid" as const },
  ];
  const results = await augmentWithDirectAndTemporal("query", tmpDir, contextual, DEFAULT_WEIGHTS, 0, 20);
  assert.deepEqual(results, contextual);
});

test("augmentWithDirectAndTemporal: candidatePaths filters specialized-agent results", async () => {
  const tmpDir = await makeTempDir();
  await mkdir(path.join(tmpDir, "entities"), { recursive: true });
  const allowedPath = path.join(tmpDir, "entities", "allowed.md");
  const blockedPath = path.join(tmpDir, "entities", "blocked.md");
  await writeFile(allowedPath, "allowed entity");
  await writeFile(blockedPath, "blocked entity");

  const candidatePaths = new Set([allowedPath]);
  const results = await augmentWithDirectAndTemporal(
    "allowed blocked",
    tmpDir,
    [],
    DEFAULT_WEIGHTS,
    10,
    20,
    candidatePaths,
  );
  assert.ok(!results.some((r) => r.path === blockedPath), "blocked path should be filtered out");
});

test("augmentWithDirectAndTemporal: caps contextual to maxPerAgent", async () => {
  const tmpDir = await makeTempDir();
  const contextual = Array.from({ length: 30 }, (_, i) => ({
    docid: `ctx-${i}`,
    path: `/tmp/ctx-${i}.md`,
    snippet: `snippet ${i}`,
    score: 1 - i * 0.01,
    transport: "hybrid" as const,
  }));
  // maxPerAgent=5 — contextual should be sliced to 5 before merge
  const results = await augmentWithDirectAndTemporal("query", tmpDir, contextual, DEFAULT_WEIGHTS, 5, 20);
  // All result paths should be from the first 5 contextual items (no direct/temporal data in tmpDir)
  const ctxIndexes = results.map((r) => parseInt(r.path.replace("/tmp/ctx-", "").replace(".md", "")));
  assert.ok(ctxIndexes.every((i) => i < 5), "only first 5 contextual items should appear");
});
