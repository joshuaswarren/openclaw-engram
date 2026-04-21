import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import {
  retrievalGraphDefinition,
  runRetrievalGraphBenchmark,
} from "./runner.js";
import { RETRIEVAL_GRAPH_FIXTURE } from "./fixture.js";

function buildOptions(
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    benchmark: { ...retrievalGraphDefinition, run: runRetrievalGraphBenchmark },
    mode: "full",
    ...overrides,
  } as ResolvedRunBenchmarkOptions;
}

test("retrievalGraphDefinition is registered with the expected shape", () => {
  assert.equal(retrievalGraphDefinition.id, "retrieval-graph");
  assert.equal(retrievalGraphDefinition.tier, "remnic");
  assert.equal(retrievalGraphDefinition.runnerAvailable, true);
});

test("runRetrievalGraphBenchmark produces a task per fixture case", async () => {
  const result = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  assert.equal(result.results.tasks.length, RETRIEVAL_GRAPH_FIXTURE.length);
  for (const task of result.results.tasks) {
    assert.ok(typeof task.scores.p_at_3_on === "number");
    assert.ok(typeof task.scores.p_at_3_off === "number");
  }
});

test("runRetrievalGraphBenchmark aggregates report graph-on vs graph-off", async () => {
  const result = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  const agg = result.results.aggregates as Record<string, unknown>;
  assert.ok(typeof agg.mean_p_at_3_on === "number");
  assert.ok(typeof agg.mean_p_at_3_off === "number");
  assert.ok(typeof agg.delta_mean_p_at_3 === "number");
  assert.equal(
    (agg.mean_p_at_3_on as number) - (agg.mean_p_at_3_off as number),
    agg.delta_mean_p_at_3,
  );
  assert.ok(typeof agg.wins === "number");
  assert.ok(typeof agg.losses === "number");
  assert.ok(typeof agg.ties === "number");
  assert.equal(
    (agg.wins as number) + (agg.losses as number) + (agg.ties as number),
    RETRIEVAL_GRAPH_FIXTURE.length,
  );
});

test("runRetrievalGraphBenchmark graph-on beats or ties graph-off on the fixture", async () => {
  const result = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  const agg = result.results.aggregates as Record<string, unknown>;
  assert.ok(
    (agg.mean_p_at_3_on as number) >= (agg.mean_p_at_3_off as number),
    `graph-on precision (${agg.mean_p_at_3_on}) regressed below graph-off (${agg.mean_p_at_3_off})`,
  );
});

test("runRetrievalGraphBenchmark quick mode runs the smoke subset", async () => {
  const full = await runRetrievalGraphBenchmark(buildOptions({ mode: "full" }));
  const quick = await runRetrievalGraphBenchmark(buildOptions({ mode: "quick" }));
  assert.ok(quick.results.tasks.length < full.results.tasks.length);
  assert.ok(quick.results.tasks.length > 0);
});

test("runRetrievalGraphBenchmark rejects non-integer / non-positive limit", async () => {
  await assert.rejects(() =>
    runRetrievalGraphBenchmark(buildOptions({ limit: 0 })),
  );
  await assert.rejects(() =>
    runRetrievalGraphBenchmark(buildOptions({ limit: 1.5 })),
  );
  await assert.rejects(() =>
    runRetrievalGraphBenchmark(buildOptions({ limit: -1 })),
  );
});
