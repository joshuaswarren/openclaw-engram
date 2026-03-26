import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQmdRecallCacheKey,
  clearQmdRecallCache,
  getCachedQmdRecall,
  setCachedQmdRecall,
} from "./qmd-recall-cache.js";

test("qmd recall cache returns fresh and then stale entries within TTL windows", async () => {
  clearQmdRecallCache();
  const key = buildQmdRecallCacheKey({
    query: "API Rate Limit issue",
    namespaces: ["work", "default"],
    recallMode: "full",
    maxResults: 8,
    memoryDir: "/tmp/engram-a",
    searchOptions: { intent: "debug", explain: true },
  });

  setCachedQmdRecall(key, { hits: ["a"] }, { maxEntries: 8 });

  const fresh = getCachedQmdRecall<{ hits: string[] }>(key, {
    freshTtlMs: 50,
    staleTtlMs: 250,
  });
  assert.equal(fresh?.source, "fresh");
  assert.deepEqual(fresh?.value.hits, ["a"]);

  await new Promise((resolve) => setTimeout(resolve, 75));

  const stale = getCachedQmdRecall<{ hits: string[] }>(key, {
    freshTtlMs: 50,
    staleTtlMs: 250,
  });
  assert.equal(stale?.source, "stale");
  assert.deepEqual(stale?.value.hits, ["a"]);
});

test("qmd recall cache key normalizes query and namespace ordering", () => {
  const left = buildQmdRecallCacheKey({
    query: "  API   RATE limit  ",
    namespaces: ["b", "a"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
  });
  const right = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
  });

  assert.equal(left, right);
});

test("qmd recall cache key scopes entries by memory root", () => {
  const left = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-a",
  });
  const right = buildQmdRecallCacheKey({
    query: "api rate limit",
    namespaces: ["a", "b"],
    recallMode: "minimal",
    maxResults: 4,
    memoryDir: "/tmp/engram-b",
  });

  assert.notEqual(left, right);
});
