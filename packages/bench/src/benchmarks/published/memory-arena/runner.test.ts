import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryArenaDefinition, runMemoryArenaBenchmark } from "./runner.ts";

test("MemoryArena derives missing categories from the source filename", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "formal_reasoning_math.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 7,
        category: null,
        questions: ["Which proof topic did we review?"],
        answers: ["number theory"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "number theory";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(
      result.results.tasks[0]?.details?.category,
      "formal_reasoning_math",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
