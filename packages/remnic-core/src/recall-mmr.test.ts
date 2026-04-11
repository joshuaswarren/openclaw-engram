import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMmrToCandidates,
  summarizeMmrDiversity,
  normalizeTokens,
  type MmrCandidate,
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
