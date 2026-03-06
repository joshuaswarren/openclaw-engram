import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { ExtractionEngine } from "../src/extraction.ts";

function buildEngine() {
  const config = {
    ...parseConfig({
      memoryDir: ".tmp/memory",
      workspaceDir: ".tmp/workspace",
      openaiApiKey: undefined,
      localLlmEnabled: false,
      localLlmFallback: true,
    }),
    openaiApiKey: undefined,
  };
  return new ExtractionEngine(config);
}

test("verifyContradiction falls back to gateway AI when no OpenAI key is configured", async () => {
  const engine = buildEngine();
  let fallbackCalled = false;
  (engine as any).fallbackLlm = {
    chatCompletion: async () => {
      fallbackCalled = true;
      return {
        content: JSON.stringify({
          isContradiction: true,
          confidence: 0.9,
          explanation: "these cannot both be true",
          winner: "new",
        }),
      };
    },
  };

  const result = await engine.verifyContradiction(
    { category: "preference", content: "User prefers dark mode" },
    {
      id: "memory-1",
      category: "preference",
      content: "User prefers light mode",
      created: "2026-03-01T00:00:00.000Z",
    },
  );

  assert.equal(fallbackCalled, true);
  assert.deepEqual(result, {
    isContradiction: true,
    confidence: 0.9,
    reasoning: "these cannot both be true",
    whichIsNewer: "second",
  });
});

test("suggestLinks falls back to gateway AI when no OpenAI key is configured", async () => {
  const engine = buildEngine();
  let fallbackCalled = false;
  (engine as any).fallbackLlm = {
    chatCompletion: async () => {
      fallbackCalled = true;
      return {
        content: JSON.stringify({
          links: [
            {
              targetId: "memory-2",
              type: "supports",
              strength: 0.81,
              reason: "same project, stronger evidence",
            },
          ],
        }),
      };
    },
  };

  const result = await engine.suggestLinks(
    { category: "fact", content: "Shipment delay came from carrier outage" },
    [{ id: "memory-2", category: "fact", content: "Carrier outage affected delivery windows" }],
  );

  assert.equal(fallbackCalled, true);
  assert.deepEqual(result, {
    links: [
      {
        targetId: "memory-2",
        linkType: "supports",
        strength: 0.81,
        reason: "same project, stronger evidence",
      },
    ],
  });
});

test("summarizeMemories falls back to gateway AI when no OpenAI key is configured", async () => {
  const engine = buildEngine();
  let fallbackCalled = false;
  (engine as any).fallbackLlm = {
    chatCompletion: async () => {
      fallbackCalled = true;
      return {
        content: JSON.stringify({
          summary: "Two shipping incidents point to carrier reliability issues.",
          keyFacts: ["Carrier outage delayed shipments", "Customers were notified about delays"],
          entities: ["carrier", "customers"],
        }),
      };
    },
  };

  const result = await engine.summarizeMemories([
    {
      id: "memory-1",
      category: "fact",
      content: "Carrier outage delayed shipments.",
      created: "2026-03-01T00:00:00.000Z",
    },
    {
      id: "memory-2",
      category: "fact",
      content: "Customers were notified about delays.",
      created: "2026-03-02T00:00:00.000Z",
    },
  ]);

  assert.equal(fallbackCalled, true);
  assert.deepEqual(result, {
    summaryText: "Two shipping incidents point to carrier reliability issues.",
    keyFacts: ["Carrier outage delayed shipments", "Customers were notified about delays"],
    keyEntities: ["carrier", "customers"],
  });
});
