import assert from "node:assert/strict";
import test from "node:test";

import {
  getMemoryForActiveMemory,
  recallForActiveMemory,
} from "./active-memory-bridge.js";

test("recallForActiveMemory caps limit, truncates snippets, and strips internal scoring fields", async () => {
  const orchestrator = {
    searchAcrossNamespaces: async () => [
      {
        id: "mem-1",
        score: 0.91,
        path: "/tmp/memory/default/facts/mem-1.md",
        snippet:
          "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
        raw_bm25: 9.2,
        raw_vector: 0.73,
        metadata: {
          type: "preference",
          topic: "style",
          updatedAt: "2026-04-12T10:00:00Z",
          sourceUri: "memory://mem-1",
        },
      },
    ],
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "writing style",
    limit: 1000,
    snippetMaxChars: 24,
    sessionKey: "session-a",
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.id, "mem-1");
  assert.equal(result.results[0]?.score, 0.91);
  assert.match(result.results[0]?.text ?? "", /^Alpha beta gamma delta/);
  assert.ok((result.results[0]?.text?.length ?? 0) <= 24);
  assert.deepEqual(result.results[0]?.metadata, {
    type: "preference",
    topic: "style",
    updatedAt: "2026-04-12T10:00:00Z",
    sourceUri: "memory://mem-1",
  });
  assert.ok(!("raw_bm25" in (result.results[0] as unknown as Record<string, unknown>)));
  assert.ok(!("raw_vector" in (result.results[0] as unknown as Record<string, unknown>)));
  assert.equal(result.truncated, false);
});

test("recallForActiveMemory marks results truncated when the underlying recall exceeds the requested limit", async () => {
  const orchestrator = {
    searchAcrossNamespaces: async () =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `mem-${index + 1}`,
        score: 0.9 - index * 0.1,
        path: `/tmp/memory/default/facts/mem-${index + 1}.md`,
        snippet: `memory ${index + 1}`,
      })),
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "project status",
    limit: 2,
    sessionKey: "session-b",
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.truncated, true);
});

test("getMemoryForActiveMemory returns not_found instead of throwing", async () => {
  const orchestrator = {
    storage: {
      getMemoryById: async () => null,
    },
  };

  const result = await getMemoryForActiveMemory(orchestrator as never, "missing");
  assert.deepEqual(result, { error: "not_found" });
});
