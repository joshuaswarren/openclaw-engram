import test from "node:test";
import assert from "node:assert/strict";

import {
  renderMemorySummary,
  approximateTokenCount,
  truncateToTokenBudget,
} from "../src/connectors/codex-materialize.js";
import type { MemoryFile } from "../src/types.js";

function makeMemory(content: string, id: string): MemoryFile {
  return {
    path: `/tmp/remnic-test/facts/${id}.md`,
    frontmatter: {
      id,
      category: "fact" as any,
      created: "2026-04-01T00:00:00Z",
      updated: "2026-04-01T00:00:00Z",
      source: "synthetic-test",
      confidence: 0.9,
      confidenceTier: "implied",
      tags: [],
    } as any,
    content,
  };
}

test("approximateTokenCount counts whitespace-separated tokens", () => {
  assert.equal(approximateTokenCount(""), 0);
  assert.equal(approximateTokenCount("one"), 1);
  assert.equal(approximateTokenCount("one two three"), 3);
  assert.equal(approximateTokenCount("  leading  and  trailing  "), 3);
});

test("truncateToTokenBudget leaves small content alone", () => {
  const text = "one two three four";
  assert.equal(truncateToTokenBudget(text, 100), text);
});

test("truncateToTokenBudget drops trailing content over budget", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve";
  const result = truncateToTokenBudget(text, 5);
  assert.ok(approximateTokenCount(result) <= 5 + 1);
  assert.match(result, /truncated/u);
});

test("renderMemorySummary stays under the configured token budget", () => {
  // Create a lot of long synthetic memories so the base rendering blows the
  // budget without truncation.
  const memories: MemoryFile[] = [];
  for (let i = 0; i < 200; i++) {
    memories.push(
      makeMemory(
        `synthetic memory payload item number ${i} with filler words intended to inflate the whitespace token count beyond the summary budget used by codex cli`,
        `syn-${i}`,
      ),
    );
  }

  const budget = 120;
  const rendered = renderMemorySummary({
    namespace: "token-ns",
    memories,
    rolloutSummaries: [],
    maxTokens: budget,
    now: new Date("2026-04-02T00:00:00Z"),
  });

  assert.ok(
    approximateTokenCount(rendered) <= budget,
    `rendered token count ${approximateTokenCount(rendered)} exceeds budget ${budget}`,
  );
});

test("renderMemorySummary with default budget stays under Codex's 5000-token cap", () => {
  const memories: MemoryFile[] = [];
  for (let i = 0; i < 50; i++) {
    memories.push(makeMemory(`synthetic memory line ${i} with a few filler tokens`, `syn-${i}`));
  }

  const rendered = renderMemorySummary({
    namespace: "default-budget-ns",
    memories,
    rolloutSummaries: [],
    maxTokens: 4500, // matches the config default
    now: new Date("2026-04-02T00:00:00Z"),
  });
  assert.ok(approximateTokenCount(rendered) < 5000);
});
