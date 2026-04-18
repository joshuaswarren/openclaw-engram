import test from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_RESULT_SCHEMA,
  getBenchmark,
  listBenchmarks,
} from "../packages/bench/src/index.js";

test("listBenchmarks exposes the published benchmark catalog from @remnic/bench", () => {
  const benchmarks = listBenchmarks();

  assert.deepEqual(
    benchmarks.map((benchmark) => benchmark.id),
    ["ama-bench", "memory-arena", "amemgym", "longmemeval", "locomo"],
  );
  assert.ok(benchmarks.every((benchmark) => benchmark.tier === "published"));
  assert.equal(
    benchmarks.filter((benchmark) => benchmark.runnerAvailable).map((benchmark) => benchmark.id).join(","),
    "memory-arena,longmemeval",
  );
});

test("getBenchmark returns memory-arena metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("memory-arena");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "memory-arena");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "agentic");
});

test("getBenchmark returns longmemeval metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("longmemeval");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "longmemeval");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("BenchmarkResult schema captures the phase-1 package contract", () => {
  assert.equal(BENCHMARK_RESULT_SCHEMA.type, "object");
  assert.deepEqual(BENCHMARK_RESULT_SCHEMA.required, [
    "meta",
    "config",
    "cost",
    "results",
    "environment",
  ]);
  assert.equal(BENCHMARK_RESULT_SCHEMA.properties.meta.type, "object");
  assert.equal(BENCHMARK_RESULT_SCHEMA.properties.results.type, "object");
});
