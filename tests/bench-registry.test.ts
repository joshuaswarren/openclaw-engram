import test from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_RESULT_SCHEMA,
  getBenchmark,
  listBenchmarks,
} from "../packages/bench/src/index.js";

test("listBenchmarks exposes the published and remnic benchmark catalog from @remnic/bench", () => {
  const benchmarks = listBenchmarks();

  assert.deepEqual(
    benchmarks.map((benchmark) => benchmark.id),
    [
      "ama-bench",
      "memory-arena",
      "amemgym",
      "longmemeval",
      "locomo",
      "beam",
      "personamem",
      "membench",
      "memoryagentbench",
      "taxonomy-accuracy",
      "extraction-judge-calibration",
      "enrichment-fidelity",
      "entity-consolidation",
      "page-versioning",
      "retrieval-personalization",
      "ingestion-entity-recall",
      "ingestion-schema-completeness",
      "ingestion-backlink-f1",
      "ingestion-setup-friction",
      "ingestion-citation-accuracy",
    ],
  );
  assert.deepEqual(
    benchmarks.map((benchmark) => benchmark.tier),
    [
      "published",
      "published",
      "published",
      "published",
      "published",
      "published",
      "published",
      "published",
      "published",
      "remnic",
      "remnic",
      "remnic",
      "remnic",
      "remnic",
      "remnic",
      "remnic",
      "remnic",
      "remnic",
      "remnic",
      "remnic",
    ],
  );
  assert.equal(
    benchmarks.filter((benchmark) => benchmark.runnerAvailable).map((benchmark) => benchmark.id).join(","),
    "ama-bench,memory-arena,amemgym,longmemeval,locomo,beam,personamem,membench,memoryagentbench,taxonomy-accuracy,extraction-judge-calibration,enrichment-fidelity,entity-consolidation,page-versioning,retrieval-personalization,ingestion-entity-recall,ingestion-backlink-f1,ingestion-setup-friction",
  );
  // Schema completeness and citation accuracy remain gated off until their adapter contracts are wired.
  assert.equal(getBenchmark("ingestion-schema-completeness")?.runnerAvailable, false);
  assert.equal(getBenchmark("ingestion-citation-accuracy")?.runnerAvailable, false);
});

test("getBenchmark returns ama-bench metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("ama-bench");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "ama-bench");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "agentic");
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

test("getBenchmark returns amemgym metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("amemgym");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "amemgym");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "agentic");
});

test("getBenchmark returns locomo metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("locomo");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "locomo");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "conversational");
});

test("getBenchmark returns beam metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("beam");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "beam");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("getBenchmark returns memoryagentbench metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("memoryagentbench");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "memoryagentbench");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "agentic");
});

test("getBenchmark returns personamem metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("personamem");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "personamem");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "conversational");
});

test("getBenchmark returns membench metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("membench");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "membench");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("getBenchmark returns taxonomy-accuracy metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("taxonomy-accuracy");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "taxonomy-accuracy");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("getBenchmark returns extraction-judge-calibration metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("extraction-judge-calibration");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "extraction-judge-calibration");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("getBenchmark returns enrichment-fidelity metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("enrichment-fidelity");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "enrichment-fidelity");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("getBenchmark returns entity-consolidation metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("entity-consolidation");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "entity-consolidation");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("getBenchmark returns page-versioning metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("page-versioning");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "page-versioning");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("getBenchmark returns retrieval-personalization metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("retrieval-personalization");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "retrieval-personalization");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "retrieval");
});

test("getBenchmark returns ingestion-entity-recall metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("ingestion-entity-recall");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "ingestion-entity-recall");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "ingestion");
});

test("getBenchmark returns ingestion-backlink-f1 metadata with a runnable benchmark entry", () => {
  const benchmark = getBenchmark("ingestion-backlink-f1");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "ingestion-backlink-f1");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, true);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "ingestion");
});

test("getBenchmark returns ingestion-schema-completeness metadata (not yet runnable)", () => {
  const benchmark = getBenchmark("ingestion-schema-completeness");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "ingestion-schema-completeness");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, false);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "ingestion");
});

test("getBenchmark returns ingestion-citation-accuracy metadata (not yet runnable)", () => {
  const benchmark = getBenchmark("ingestion-citation-accuracy");

  assert.ok(benchmark);
  assert.equal(benchmark?.id, "ingestion-citation-accuracy");
  assert.equal(benchmark?.status, "ready");
  assert.equal(benchmark?.runnerAvailable, false);
  assert.equal(benchmark?.tier, "remnic");
  assert.equal(benchmark?.meta.category, "ingestion");
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
