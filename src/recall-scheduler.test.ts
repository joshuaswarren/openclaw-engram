import assert from "node:assert/strict";
import test from "node:test";

import { runRecallSections, type RecallSectionSpec } from "./recall-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("runRecallSections resolves core sections before enrichment sections", async () => {
  const events: string[] = [];
  const releaseCore = deferred<void>();

  const specs: RecallSectionSpec<string>[] = [
    {
      id: "slow-core",
      priority: "core",
      timeoutMs: 1_000,
      run: async () => {
        events.push("core:start");
        await releaseCore.promise;
        events.push("core:finish");
        return "core";
      },
    },
    {
      id: "fast-enrichment",
      priority: "enrichment",
      timeoutMs: 1_000,
      run: async () => {
        events.push("enrichment:start");
        return "enrichment";
      },
    },
  ];

  const runPromise = runRecallSections(specs);
  await Promise.resolve();
  assert.deepEqual(events, ["core:start"]);

  releaseCore.resolve();
  const results = await runPromise;

  assert.deepEqual(events, ["core:start", "core:finish", "enrichment:start"]);
  assert.deepEqual(
    results.map((result) => [result.id, result.source, result.completion]),
    [
      ["slow-core", "fresh", "completed"],
      ["fast-enrichment", "fresh", "completed"],
    ],
  );
});

test("runRecallSections returns stale fallback when an enrichment section times out", async () => {
  const specs: RecallSectionSpec<string>[] = [
    {
      id: "timed-enrichment",
      priority: "enrichment",
      timeoutMs: 10,
      run: async (signal) => {
        await new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
        return "unreachable";
      },
      fallback: async (reason) => `fallback:${reason}`,
    },
  ];

  const [result] = await runRecallSections(specs);
  assert.equal(result?.source, "stale");
  assert.equal(result?.completion, "timed_out");
  assert.equal(result?.value, "fallback:timed_out");
});

test("runRecallSections aborts pending sections before they start", async () => {
  const controller = new AbortController();
  const releaseCore = deferred<void>();
  let enrichmentRan = false;

  const specs: RecallSectionSpec<string>[] = [
    {
      id: "core",
      priority: "core",
      timeoutMs: 1_000,
      run: async () => {
        controller.abort(new Error("stop"));
        releaseCore.resolve();
        return "core";
      },
    },
    {
      id: "pending-enrichment",
      priority: "enrichment",
      timeoutMs: 1_000,
      run: async () => {
        enrichmentRan = true;
        return "enrichment";
      },
    },
  ];

  const results = await runRecallSections(specs, controller.signal);
  assert.equal(enrichmentRan, false);
  assert.deepEqual(
    results.map((result) => [result.id, result.completion, result.source]),
    [
      ["core", "completed", "fresh"],
      ["pending-enrichment", "aborted", "skip"],
    ],
  );
});
