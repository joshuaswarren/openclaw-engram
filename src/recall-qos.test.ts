import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecallSectionMetricRecorder,
  type RecallSectionMetric,
} from "./recall-qos.js";

test("recall section metric recorder stores timing strings and logs core success at info level", () => {
  const timings: Record<string, string> = {};
  const calls: Array<{ level: "info" | "debug"; message: string; payload: unknown[] }> = [];
  const recorder = createRecallSectionMetricRecorder({
    timings,
    logger: {
      info: (message: string, ...payload: unknown[]) => {
        calls.push({ level: "info", message, payload });
      },
      debug: (message: string, ...payload: unknown[]) => {
        calls.push({ level: "debug", message, payload });
      },
    },
  });

  const metric: RecallSectionMetric = {
    section: "profile",
    priority: "core",
    durationMs: 12,
    deadlineMs: 75_000,
    source: "fresh",
    success: true,
  };

  recorder(metric);

  assert.equal(timings.profile, "12ms");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.level, "info");
  assert.equal(calls[0]?.message, "recall section metric");
  assert.deepEqual(calls[0]?.payload[0], {
    section: "profile",
    priority: "core",
    durationMs: 12,
    deadlineMs: 75_000,
    source: "fresh",
    success: true,
  });
});

test("recall section metric recorder respects timing overrides and logs enrichment skips at debug level", () => {
  const timings: Record<string, string> = {};
  const calls: Array<{ level: "info" | "debug"; message: string; payload: unknown[] }> = [];
  const recorder = createRecallSectionMetricRecorder({
    timings,
    logger: {
      info: (message: string, ...payload: unknown[]) => {
        calls.push({ level: "info", message, payload });
      },
      debug: (message: string, ...payload: unknown[]) => {
        calls.push({ level: "debug", message, payload });
      },
    },
  });

  recorder({
    section: "qmd",
    priority: "enrichment",
    durationMs: 0,
    deadlineMs: 25_000,
    source: "skip",
    success: true,
    timing: "skip(limit=0)",
  });

  assert.equal(timings.qmd, "skip(limit=0)");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.level, "debug");
  assert.equal(calls[0]?.message, "recall section metric");
  assert.deepEqual(calls[0]?.payload[0], {
    section: "qmd",
    priority: "enrichment",
    durationMs: 0,
    deadlineMs: 25_000,
    source: "skip",
    success: true,
  });
});
