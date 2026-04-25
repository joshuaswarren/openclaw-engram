import test from "node:test";
import assert from "node:assert/strict";
import {
  runRetentionAgedDatasetBenchmark,
  retentionAgedDatasetDefinition,
} from "./runner.js";
import { generateAgedDataset } from "./fixture.js";
import type { ResolvedRunBenchmarkOptions } from "../../../types.js";

function options(overrides: Partial<ResolvedRunBenchmarkOptions> = {}): ResolvedRunBenchmarkOptions {
  return {
    mode: "quick",
    benchmark: retentionAgedDatasetDefinition,
    system: { describe: () => "noop", store: async () => undefined, query: async () => "" },
    ...overrides,
  } as ResolvedRunBenchmarkOptions;
}

test("aged-dataset fixture is deterministic given a seed", () => {
  const a = generateAgedDataset({
    size: 50,
    horizonDays: 365,
    topicCount: 4,
    paretoAlpha: 1.16,
    ageSkew: 1.5,
    seed: 12345,
    nowIso: "2026-04-25T12:00:00.000Z",
  });
  const b = generateAgedDataset({
    size: 50,
    horizonDays: 365,
    topicCount: 4,
    paretoAlpha: 1.16,
    ageSkew: 1.5,
    seed: 12345,
    nowIso: "2026-04-25T12:00:00.000Z",
  });
  assert.equal(a.memories.length, b.memories.length);
  assert.equal(a.queries.length, b.queries.length);
  for (let i = 0; i < a.memories.length; i += 1) {
    assert.equal(a.memories[i].frontmatter.id, b.memories[i].frontmatter.id);
    assert.equal(
      a.memories[i].frontmatter.created,
      b.memories[i].frontmatter.created,
    );
    assert.equal(
      a.memories[i].frontmatter.accessCount,
      b.memories[i].frontmatter.accessCount,
    );
  }
});

test("aged-dataset bench runs in quick mode and emits expected metrics", async () => {
  const result = await runRetentionAgedDatasetBenchmark(options());
  assert.ok(result.results.tasks.length > 0, "must emit at least one task");
  for (const task of result.results.tasks) {
    assert.ok("recall_at_5_full" in task.scores);
    assert.ok("recall_at_5_hot_only" in task.scores);
    assert.ok("recall_at_5_delta" in task.scores);
    assert.ok("hot_share" in task.scores);
    assert.ok("cold_share" in task.scores);
    // recall@K is in [0, 1].
    assert.ok(task.scores.recall_at_5_full >= 0 && task.scores.recall_at_5_full <= 1);
    assert.ok(task.scores.recall_at_5_hot_only >= 0 && task.scores.recall_at_5_hot_only <= 1);
    // hot_share + cold_share should sum to 1 (within float epsilon).
    const sum = task.scores.hot_share + task.scores.cold_share;
    assert.ok(Math.abs(sum - 1) < 1e-9, `hot+cold share must sum to 1, got ${sum}`);
  }
  assert.ok(
    typeof result.cost.meanQueryLatencyMs === "number",
    "meanQueryLatencyMs must be a number",
  );
});

test("aged-dataset bench reports plausible hot/cold split for default policy", async () => {
  const result = await runRetentionAgedDatasetBenchmark(options());
  // The default policy demotes memories ≥14d old with value ≤ 0.35. With
  // ageSkew=1.5 and a 365d horizon, a meaningful fraction of memories
  // should land in the cold tier — but not all of them (recently-created
  // and high-value memories must stay hot). Use loose bounds so this
  // doesn't false-fail when defaults change in PR 3.
  const firstTask = result.results.tasks[0];
  assert.ok(firstTask, "expected at least one task");
  const coldShare = firstTask.scores.cold_share;
  assert.ok(
    coldShare > 0,
    `default policy must demote some memories at 1y horizon; cold_share=${coldShare}`,
  );
  assert.ok(
    coldShare < 1,
    `default policy must keep some memories hot; cold_share=${coldShare}`,
  );
});

test("aged-dataset bench applies options.limit to fixture queries", async () => {
  const unlimited = await runRetentionAgedDatasetBenchmark(options());
  const limited = await runRetentionAgedDatasetBenchmark(options({ limit: 1 }));
  assert.ok(unlimited.results.tasks.length >= 2);
  assert.equal(limited.results.tasks.length, 1);
});

test("aged-dataset bench threads options.seed into the generator", async () => {
  const a = await runRetentionAgedDatasetBenchmark(options({ seed: 1234 }));
  const b = await runRetentionAgedDatasetBenchmark(options({ seed: 5678 }));
  // Different seed → different fixture → different first-task topFull.
  const aTopFull = JSON.parse(a.results.tasks[0].actual).topFull;
  const bTopFull = JSON.parse(b.results.tasks[0].actual).topFull;
  assert.notDeepEqual(
    aTopFull,
    bTopFull,
    "different seeds must produce different fixtures",
  );
  // And meta.seeds must reflect the seed actually used (not the
  // hardcoded baseOptions seed).
  assert.deepEqual(a.meta.seeds, [1234]);
  assert.deepEqual(b.meta.seeds, [5678]);
});

test("aged-dataset bench produces non-empty aggregates", async () => {
  const result = await runRetentionAgedDatasetBenchmark(options());
  // Aggregate keys should include the per-task score names. If we used
  // buildTieredAggregates without setting details.tier, this object
  // would be empty.
  const keys = Object.keys(result.results.aggregates);
  assert.ok(
    keys.includes("recall_at_5_full"),
    `aggregates must include recall_at_5_full, got: ${keys.join(",")}`,
  );
  assert.ok(
    keys.includes("recall_at_5_hot_only"),
    `aggregates must include recall_at_5_hot_only, got: ${keys.join(",")}`,
  );
});
