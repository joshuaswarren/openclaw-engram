import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadBenchResultSummaries } from "../packages/bench-ui/src/results.js";

test("bench UI loader summarizes valid benchmark JSON files and ignores invalid entries", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-"));

  await writeFile(
    path.join(resultsDir, "latest.json"),
    JSON.stringify({
      meta: {
        id: "latest-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
      },
      cost: {
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
      },
      results: {
        tasks: [{ id: "task-1" }, { id: "task-2" }],
        aggregates: {
          accuracy: { mean: 0.75 },
          f1: { mean: 0.63 },
          llm_judge: { mean: 0.9 },
          ignored: { mean: "bad" },
        },
      },
    }, null, 2),
  );

  await writeFile(
    path.join(resultsDir, "older.json"),
    JSON.stringify({
      meta: {
        id: "older-run",
        benchmark: "ama-bench",
        timestamp: "2026-04-17T10:00:00.000Z",
        mode: "full",
      },
      cost: {
        totalLatencyMs: 99,
        meanQueryLatencyMs: 33,
      },
      results: {
        tasks: [],
        aggregates: {},
      },
    }, null, 2),
  );

  await writeFile(path.join(resultsDir, "broken.json"), "{oops");
  await mkdir(path.join(resultsDir, "nested"));

  const payload = await loadBenchResultSummaries(resultsDir);

  assert.equal(payload.resultsDir, resultsDir);
  assert.equal(payload.summaries.length, 2);
  assert.deepEqual(payload.summaries.map((summary) => summary.id), [
    "latest-run",
    "older-run",
  ]);
  assert.equal(payload.summaries[0]?.taskCount, 2);
  assert.deepEqual(payload.summaries[0]?.metricHighlights, [
    { name: "accuracy", mean: 0.75 },
    { name: "f1", mean: 0.63 },
    { name: "llm_judge", mean: 0.9 },
  ]);
});

test("bench UI loader returns an empty payload when the results directory is missing", async () => {
  const resultsDir = path.join(os.tmpdir(), "remnic-bench-ui-missing");
  const payload = await loadBenchResultSummaries(resultsDir);

  assert.equal(payload.resultsDir, resultsDir);
  assert.deepEqual(payload.summaries, []);
});
