import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("successful qmd fetches refresh the cache even when no hits are returned", async () => {
  const source = await readFile(
    new URL("../src/orchestrator.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    source.includes("setCachedQmdRecall(qmdCacheKey, result, {"),
    true,
  );
  assert.equal(
    source.includes(
      "if (augmentedResults.length > 0 || result.globalResults.length > 0) {\n            setCachedQmdRecall(qmdCacheKey, result, {",
    ),
    false,
  );
});
