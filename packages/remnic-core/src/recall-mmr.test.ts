import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMmrToCandidates,
  reorderRecallResultsWithMmr,
  summarizeMmrDiversity,
  normalizeTokens,
  type MmrCandidate,
  type MmrRecallResult,
} from "./recall-mmr.js";

function makeCandidate(
  id: string,
  content: string,
  score: number,
  embedding?: number[],
): MmrCandidate {
  return { id, content, score, embedding: embedding ?? null };
}

test("applyMmrToCandidates returns [] for empty input", () => {
  const out = applyMmrToCandidates({ candidates: [] });
  assert.deepEqual(out, []);
});

test("applyMmrToCandidates is a no-op for a single candidate", () => {
  const input = [makeCandidate("a", "hello", 1)];
  const out = applyMmrToCandidates({ candidates: input });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.id, "a");
});

test("applyMmrToCandidates does not mutate input", () => {
  const input: MmrCandidate[] = [
    makeCandidate("a", "one", 0.9, [1, 0, 0, 0]),
    makeCandidate("b", "two", 0.8, [0, 1, 0, 0]),
  ];
  const before = input.map((c) => c.id).join(",");
  applyMmrToCandidates({ candidates: input, budget: 1 });
  assert.equal(
    input.map((c) => c.id).join(","),
    before,
    "input order should be unchanged",
  );
});

test("applyMmrToCandidates collapses near-duplicate clusters (cosine)", () => {
  // Five near-duplicate candidates all pointing toward [1,0,0,0] with tiny
  // perturbations, plus four diverse candidates along orthogonal axes.
  const epsilon = 0.001;
  const nearDupe = (idx: number): number[] => [1, epsilon * idx, 0, 0];
  const candidates: MmrCandidate[] = [
    makeCandidate("dupe-1", "alpha one", 0.99, nearDupe(1)),
    makeCandidate("dupe-2", "alpha two", 0.98, nearDupe(2)),
    makeCandidate("dupe-3", "alpha three", 0.97, nearDupe(3)),
    makeCandidate("dupe-4", "alpha four", 0.96, nearDupe(4)),
    makeCandidate("dupe-5", "alpha five", 0.95, nearDupe(5)),
    makeCandidate("div-y", "beta", 0.9, [0, 1, 0, 0]),
    makeCandidate("div-z", "gamma", 0.85, [0, 0, 1, 0]),
    makeCandidate("div-w", "delta", 0.8, [0, 0, 0, 1]),
    makeCandidate("div-a", "epsilon", 0.75, [1, 1, 0, 0]),
  ];

  // Budget = 4 — with 4 distinct axes available (plus a 5th dupe cluster),
  // MMR should pick 1 dupe + 3 diverse before ever revisiting the cluster.
  const selected = applyMmrToCandidates({
    candidates,
    lambda: 0.5, // balance relevance + diversity
    topN: 40,
    budget: 4,
  });

  assert.equal(selected.length, 4);

  const dupeCount = selected.filter((c) => c.id.startsWith("dupe-")).length;
  assert.ok(
    dupeCount <= 1,
    `expected at most 1 representative from the duplicate cluster, got ${dupeCount}: ${selected
      .map((c) => c.id)
      .join(",")}`,
  );

  // The highest-relevance duplicate should still be included.
  const ids = selected.map((c) => c.id);
  assert.ok(ids.includes("dupe-1"), `expected dupe-1 in selection: ${ids}`);
  // All three fully diverse axes should also surface.
  assert.ok(ids.includes("div-y"));
  assert.ok(ids.includes("div-z"));
  assert.ok(ids.includes("div-w"));
});

test("applyMmrToCandidates falls back to Jaccard when embeddings are missing", () => {
  // Three candidates with heavy lexical overlap + two diverse ones.
  const candidates: MmrCandidate[] = [
    makeCandidate(
      "s1",
      "The cat sat on the red mat in the sunny kitchen",
      0.95,
    ),
    makeCandidate(
      "s2",
      "The cat sat on the red mat in the sunny kitchen today",
      0.94,
    ),
    makeCandidate(
      "s3",
      "A cat is sitting on the red mat in the kitchen",
      0.93,
    ),
    makeCandidate(
      "d1",
      "Quantum tunneling explains alpha decay in heavy nuclei",
      0.5,
    ),
    makeCandidate(
      "d2",
      "Bicycle gears shift when pedaling uphill on pavement",
      0.4,
    ),
  ];

  const selected = applyMmrToCandidates({
    candidates,
    lambda: 0.4, // push harder toward diversity so clustering shows up
    topN: 40,
    budget: 3,
  });

  assert.equal(selected.length, 3);
  const ids = selected.map((c) => c.id);
  // The top-scored lexical duplicate should be included...
  assert.ok(ids.includes("s1"));
  // ...but MMR should prefer the diverse candidates over the other near-dupes.
  const sxCount = ids.filter((id) => id.startsWith("s")).length;
  assert.ok(
    sxCount < 3,
    `MMR should not fill the slate with lexical duplicates: ${ids.join(",")}`,
  );
  assert.ok(
    ids.includes("d1") || ids.includes("d2"),
    `at least one diverse candidate should appear: ${ids.join(",")}`,
  );
});

test("applyMmrToCandidates is sensitive to lambda", () => {
  const candidates: MmrCandidate[] = [
    makeCandidate("a", "alpha one", 1.0, [1, 0.001, 0, 0]),
    makeCandidate("b", "alpha two", 0.99, [1, 0.002, 0, 0]),
    makeCandidate("c", "beta", 0.5, [0, 1, 0, 0]),
    makeCandidate("d", "gamma", 0.4, [0, 0, 1, 0]),
  ];

  // Lambda = 1.0 → pure relevance, no diversity adjustment.
  const pureRelevance = applyMmrToCandidates({
    candidates,
    lambda: 1.0,
    budget: 2,
  });
  assert.deepEqual(pureRelevance.map((c) => c.id), ["a", "b"]);

  // Lambda = 0.2 → diversity dominates, the second pick should avoid the
  // near-duplicate of `a`.
  const diverse = applyMmrToCandidates({
    candidates,
    lambda: 0.2,
    budget: 2,
  });
  assert.equal(diverse[0]?.id, "a", "highest-relevance should still lead");
  assert.notEqual(
    diverse[1]?.id,
    "b",
    "diversity-heavy MMR should avoid the near-duplicate",
  );
});

test("applyMmrToCandidates preserves all candidates when budget >= length", () => {
  const candidates: MmrCandidate[] = [
    makeCandidate("a", "one", 1, [1, 0, 0]),
    makeCandidate("b", "two", 0.9, [0, 1, 0]),
    makeCandidate("c", "three", 0.8, [0, 0, 1]),
  ];
  const out = applyMmrToCandidates({
    candidates,
    budget: 10,
  });
  assert.equal(out.length, 3);
  const ids = out.map((c) => c.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("applyMmrToCandidates respects topN clamping", () => {
  const candidates: MmrCandidate[] = Array.from({ length: 50 }, (_, i) =>
    makeCandidate(`c-${i}`, `content ${i}`, 1 - i * 0.01, [1, i * 0.001, 0]),
  );
  const out = applyMmrToCandidates({
    candidates,
    topN: 10,
    budget: 5,
  });
  assert.equal(out.length, 5);
  // All selected should come from the top 10 (indices 0-9).
  for (const c of out) {
    const idx = Number.parseInt(c.id.split("-")[1]!, 10);
    assert.ok(idx < 10, `selected candidate ${c.id} outside topN window`);
  }
});

test("applyMmrToCandidates handles budget=0 as empty selection", () => {
  const candidates = [makeCandidate("a", "one", 1), makeCandidate("b", "two", 0.5)];
  const out = applyMmrToCandidates({ candidates, budget: 0 });
  // budget=0 is clamped to 0, nothing selected
  assert.equal(out.length, 0);
});

test("summarizeMmrDiversity reports higher before-sim for dup-heavy input", () => {
  const dupHeavy: MmrCandidate[] = [
    makeCandidate("a", "the cat sat on the mat", 1, [1, 0.001, 0]),
    makeCandidate("b", "a cat sat on the mat", 0.99, [1, 0.002, 0]),
    makeCandidate("c", "cats sit on mats", 0.98, [1, 0.003, 0]),
  ];
  const diversified = applyMmrToCandidates({
    candidates: dupHeavy.concat([
      makeCandidate("d", "rocket thrust vectoring", 0.5, [0, 1, 0]),
      makeCandidate("e", "violin bow rosin", 0.4, [0, 0, 1]),
    ]),
    lambda: 0.4,
    budget: 3,
  });

  const report = summarizeMmrDiversity(dupHeavy, diversified, 40);
  assert.ok(
    report.avgPairwiseSimAfter <= report.avgPairwiseSimBefore + 1e-9,
    `avg pairwise similarity should not increase after MMR: before=${report.avgPairwiseSimBefore} after=${report.avgPairwiseSimAfter}`,
  );
});

test("normalizeTokens lowercases and strips punctuation", () => {
  assert.deepEqual(
    [...normalizeTokens("Hello, World! 42 TIMES.")],
    ["hello", "world", "42", "times"],
  );
  assert.deepEqual([...normalizeTokens("")], []);
  assert.deepEqual([...normalizeTokens("   ")], []);
});

test("applyMmrToCandidates end-to-end: duplicate sentences reduced vs disabled", () => {
  // Small seeded fixture: 4 near-duplicate "fact" sentences + 3 diverse.
  const fixture: MmrCandidate[] = [
    makeCandidate(
      "f1",
      "The user prefers dark mode for their terminal",
      0.95,
    ),
    makeCandidate(
      "f2",
      "User likes dark mode in the terminal interface",
      0.94,
    ),
    makeCandidate(
      "f3",
      "Prefers dark mode setting for terminal usage",
      0.93,
    ),
    makeCandidate(
      "f4",
      "The terminal should use dark mode",
      0.92,
    ),
    makeCandidate("d1", "Coffee is brewed at 195 degrees fahrenheit", 0.8),
    makeCandidate("d2", "The sunset reflected orange on the ocean waves", 0.75),
    makeCandidate("d3", "Linear algebra underpins modern machine learning", 0.7),
  ];

  // Without MMR: top-4 would be f1..f4, all near-duplicates.
  const noMmrTop4 = fixture.slice(0, 4);
  const mmrTop4 = applyMmrToCandidates({
    candidates: fixture,
    lambda: 0.4,
    budget: 4,
  });

  const noMmrIds = noMmrTop4.map((c) => c.id);
  const mmrIds = mmrTop4.map((c) => c.id);

  const countDupes = (ids: string[]) =>
    ids.filter((id) => id.startsWith("f")).length;

  assert.ok(
    countDupes(mmrIds) < countDupes(noMmrIds),
    `MMR should strictly reduce duplicate cluster count: noMmr=${noMmrIds} mmr=${mmrIds}`,
  );
  assert.ok(
    mmrIds.some((id) => id.startsWith("d")),
    `MMR should surface at least one diverse candidate: ${mmrIds}`,
  );
});

// ---------------------------------------------------------------------------
// Regression: path-first keying for reorderRecallResultsWithMmr
// (ChatGPT Codex P2 review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "reorderRecallResultsWithMmr preserves distinct results that share a docid",
  () => {
    // Two results with IDENTICAL docids but DIFFERENT paths. A docid-keyed
    // implementation would collapse these into one and silently drop a valid
    // recall candidate.
    const results: MmrRecallResult[] = [
      {
        docid: "fact-007",
        path: "memories/facts/source-a/fact-007.md",
        snippet: "Some fact from source A",
        score: 0.95,
      },
      {
        docid: "fact-007",
        path: "memories/facts/source-b/fact-007.md",
        snippet: "A very different fact from source B",
        score: 0.92,
      },
      {
        docid: "fact-008",
        path: "memories/facts/source-a/fact-008.md",
        snippet: "Yet another unrelated fact",
        score: 0.9,
      },
    ];

    const { reordered } = reorderRecallResultsWithMmr(results);

    assert.equal(
      reordered.length,
      results.length,
      "no candidate should be dropped when docids collide across paths",
    );
    const paths = reordered.map((r) => r.path).sort();
    assert.deepEqual(paths, [
      "memories/facts/source-a/fact-007.md",
      "memories/facts/source-a/fact-008.md",
      "memories/facts/source-b/fact-007.md",
    ]);
  },
);

test(
  "reorderRecallResultsWithMmr keeps results with empty path AND empty docid distinct",
  () => {
    // Pathological input: every result has empty path and empty docid. The
    // stable index-suffix fallback must still give each candidate its own
    // key so none of them collapse.
    const results: MmrRecallResult[] = [
      { docid: "", path: "", snippet: "alpha content", score: 0.9 },
      { docid: "", path: "", snippet: "beta content", score: 0.8 },
      { docid: "", path: "", snippet: "gamma content", score: 0.7 },
    ];

    const { reordered } = reorderRecallResultsWithMmr(results);
    assert.equal(reordered.length, 3);
    const snippets = reordered.map((r) => r.snippet).sort();
    assert.deepEqual(snippets, ["alpha content", "beta content", "gamma content"]);
  },
);

// ---------------------------------------------------------------------------
// Regression: head-of-list diversity metric actually reflects reordering
// (Cursor Bugbot Medium review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "summarizeMmrDiversity with small sample size reflects head-of-list reordering",
  () => {
    // Input: 5 near-duplicate high-score "a*" candidates up front, then 3
    // diverse candidates. With `budget = candidates.length`, MMR reorders but
    // drops nothing — the two slices pre- and post-MMR contain the same
    // SET. If the diversity metric used a large sample size it would report
    // identical before/after averages. With a small head-of-list sample size
    // the head *does* differ, so avgPairwiseSimAfter < avgPairwiseSimBefore.
    const candidates: MmrCandidate[] = [
      { id: "a1", content: "alpha", score: 0.99, embedding: [1, 0.001, 0] },
      { id: "a2", content: "alpha", score: 0.98, embedding: [1, 0.002, 0] },
      { id: "a3", content: "alpha", score: 0.97, embedding: [1, 0.003, 0] },
      { id: "a4", content: "alpha", score: 0.96, embedding: [1, 0.004, 0] },
      { id: "a5", content: "alpha", score: 0.95, embedding: [1, 0.005, 0] },
      { id: "b1", content: "beta", score: 0.9, embedding: [0, 1, 0] },
      { id: "b2", content: "gamma", score: 0.85, embedding: [0, 0, 1] },
      { id: "b3", content: "delta", score: 0.8, embedding: [1, 1, 0] },
    ];

    const reordered = applyMmrToCandidates({
      candidates,
      lambda: 0.3, // push hard toward diversity
      budget: candidates.length, // same set, just reordered — same bug regime
    });
    assert.equal(reordered.length, candidates.length);

    // Default small sample size (10 is larger than our 8-element pool, so
    // everything is compared — this recreates the bug the comment flagged).
    const trivialReport = summarizeMmrDiversity(
      candidates,
      reordered,
      candidates.length,
    );
    // With full-pool sampling the before/after average pairwise similarity
    // is order-independent — the bug condition.
    assert.ok(
      Math.abs(trivialReport.avgPairwiseSimBefore - trivialReport.avgPairwiseSimAfter) < 1e-9,
      "sanity: full-pool sampling is order-independent and hides diversity gains",
    );

    // With a small head-of-list sample size (4), MMR's reordering *must*
    // show up as a strictly lower average pairwise similarity.
    const headReport = summarizeMmrDiversity(candidates, reordered, 4);
    assert.ok(
      headReport.avgPairwiseSimAfter + 1e-9 < headReport.avgPairwiseSimBefore,
      `head-of-list sample should show MMR diversity gain: before=${headReport.avgPairwiseSimBefore} after=${headReport.avgPairwiseSimAfter}`,
    );
  },
);

// ---------------------------------------------------------------------------
// Regression: MMR must run before truncation so diverse candidates just below
// the cutoff can be promoted into the final injected set.
// (ChatGPT Codex P2 review comment on PR #391)
// ---------------------------------------------------------------------------

test(
  "reorderRecallResultsWithMmr promotes sub-cutoff diverse candidates when run pre-slice",
  () => {
    // Simulate a near-duplicate cluster of 5 high-score candidates followed
    // by a truly diverse candidate at position 5 (just below a final limit
    // of 5). If MMR ran only on the already-truncated top-5, the diverse
    // candidate would never make it into the injected set. Running MMR on
    // the full 6-candidate pool and then slicing to 5 must pull the diverse
    // candidate into the final slice.
    const results: MmrRecallResult[] = [
      { docid: "a1", path: "p/a1", snippet: "alpha fact one", score: 0.99 },
      { docid: "a2", path: "p/a2", snippet: "alpha fact two", score: 0.98 },
      { docid: "a3", path: "p/a3", snippet: "alpha fact three", score: 0.97 },
      { docid: "a4", path: "p/a4", snippet: "alpha fact four", score: 0.96 },
      { docid: "a5", path: "p/a5", snippet: "alpha fact five", score: 0.95 },
      {
        docid: "d1",
        path: "p/d1",
        snippet: "orthogonal concept rocket fuel chemistry",
        score: 0.94,
      },
    ];

    // Simulate the buggy "slice then MMR" behavior.
    const sliceFirst = results.slice(0, 5);
    const sliceFirstMmr = reorderRecallResultsWithMmr(sliceFirst, {
      lambda: 0.3,
    }).reordered;
    const sliceFirstIds = sliceFirstMmr.map((r) => r.docid);
    assert.ok(
      !sliceFirstIds.includes("d1"),
      "sanity: slicing before MMR cannot recover the sub-cutoff diverse candidate",
    );

    // Now the correct "MMR then slice" behavior.
    const mmrFirst = reorderRecallResultsWithMmr(results, {
      lambda: 0.3,
    }).reordered.slice(0, 5);
    const mmrFirstIds = mmrFirst.map((r) => r.docid);
    assert.equal(mmrFirst.length, 5);
    assert.ok(
      mmrFirstIds.includes("d1"),
      `MMR-then-slice should promote the diverse candidate into the top-5: ${mmrFirstIds.join(",")}`,
    );
  },
);

test(
  "reorderRecallResultsWithMmr with topN=0 is a full no-op preserving input order",
  () => {
    // AGENTS.md §4: never coerce zero limits to non-zero. A topN of 0 means
    // "apply MMR over an empty window" — no candidate gets dropped and the
    // original order is preserved.
    const results: MmrRecallResult[] = [
      { docid: "a", path: "p/a", snippet: "one", score: 0.9 },
      { docid: "b", path: "p/b", snippet: "two", score: 0.8 },
      { docid: "c", path: "p/c", snippet: "three", score: 0.7 },
    ];
    const { reordered } = reorderRecallResultsWithMmr(results, { topN: 0 });
    assert.equal(reordered.length, results.length);
    assert.deepEqual(
      reordered.map((r) => r.docid),
      ["a", "b", "c"],
      "topN=0 should be a no-op and preserve input order",
    );
  },
);

test(
  "reorderRecallResultsWithMmr diversity report defaults to head-of-list sample",
  () => {
    // Integration check for the orchestration helper: even with
    // `budget = results.length`, the default diversity report should surface
    // the fact that MMR promoted diverse candidates to the head.
    const results: MmrRecallResult[] = [
      { docid: "a1", path: "p/a1", snippet: "the quick brown fox jumps over the lazy dog", score: 0.99 },
      { docid: "a2", path: "p/a2", snippet: "the quick brown fox jumps over a lazy dog", score: 0.98 },
      { docid: "a3", path: "p/a3", snippet: "a quick brown fox jumps over the lazy dog", score: 0.97 },
      { docid: "a4", path: "p/a4", snippet: "quick brown fox jumping over lazy dogs", score: 0.96 },
      { docid: "a5", path: "p/a5", snippet: "brown foxes jumping over lazy dogs", score: 0.95 },
      { docid: "d1", path: "p/d1", snippet: "rocket thrust vectoring", score: 0.6 },
      { docid: "d2", path: "p/d2", snippet: "violin bow rosin reservoir", score: 0.5 },
      { docid: "d3", path: "p/d3", snippet: "coffee brewing at high altitude", score: 0.4 },
    ];

    const { reordered, diversity } = reorderRecallResultsWithMmr(results, {
      lambda: 0.3,
      diversitySampleSize: 4,
    });
    assert.equal(reordered.length, results.length);
    assert.ok(
      diversity.avgPairwiseSimAfter + 1e-9 < diversity.avgPairwiseSimBefore,
      `head-of-list MMR should lower avg pairwise similarity: before=${diversity.avgPairwiseSimBefore} after=${diversity.avgPairwiseSimAfter}`,
    );
    // Sanity: MMR should have pulled at least one diverse candidate into the head.
    const headDocids = reordered.slice(0, 4).map((r) => r.docid);
    assert.ok(
      headDocids.some((d) => d && d.startsWith("d")),
      `expected a diverse candidate in the head after MMR: ${headDocids.join(",")}`,
    );
  },
);
