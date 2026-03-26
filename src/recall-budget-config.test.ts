import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";

test("parseConfig applies recall timeout and qmd recall cache defaults", () => {
  const config = parseConfig({});

  assert.equal(config.recallOuterTimeoutMs, 75_000);
  assert.equal(config.recallCoreDeadlineMs, 75_000);
  assert.equal(config.recallEnrichmentDeadlineMs, 25_000);
  assert.equal(config.qmdRecallCacheTtlMs, 60_000);
  assert.equal(config.qmdRecallCacheStaleTtlMs, 10 * 60_000);
  assert.equal(config.qmdRecallCacheMaxEntries, 128);
});

test("parseConfig respects explicit recall timeout and qmd recall cache settings", () => {
  const config = parseConfig({
    recallOuterTimeoutMs: 18_000,
    recallCoreDeadlineMs: 9_000,
    recallEnrichmentDeadlineMs: 2_500,
    qmdRecallCacheTtlMs: 5_000,
    qmdRecallCacheStaleTtlMs: 45_000,
    qmdRecallCacheMaxEntries: 32,
  });

  assert.equal(config.recallOuterTimeoutMs, 18_000);
  assert.equal(config.recallCoreDeadlineMs, 9_000);
  assert.equal(config.recallEnrichmentDeadlineMs, 2_500);
  assert.equal(config.qmdRecallCacheTtlMs, 5_000);
  assert.equal(config.qmdRecallCacheStaleTtlMs, 45_000);
  assert.equal(config.qmdRecallCacheMaxEntries, 32);
});

test("parseConfig preserves zero qmd recall cache entries to disable caching", () => {
  const config = parseConfig({
    qmdRecallCacheMaxEntries: 0,
  });

  assert.equal(config.qmdRecallCacheMaxEntries, 0);
});
