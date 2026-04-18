import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { memoryArenaRunner } from "../packages/bench/src/benchmarks/published/memory-arena/runner.ts";

test("memoryArenaRunner fails fast when a question is missing a matching answer entry", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memory-arena-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["What product should we buy?"],
      answers: [],
    })}\n`,
    "utf8",
  );

  const storedTurns: Array<{ sessionId: string; content: string }> = [];
  const system = {
    async reset(): Promise<void> {},
    async store(
      sessionId: string,
      messages: Array<{ role: string; content: string }>,
    ): Promise<void> {
      for (const message of messages) {
        storedTurns.push({ sessionId, content: message.content });
      }
    },
    async recall(): Promise<string> {
      return "";
    },
    async search(): Promise<Array<unknown>> {
      return [];
    },
    async getStats(): Promise<{
      totalMessages: number;
      totalSummaryNodes: number;
      maxDepth: number;
    }> {
      return {
        totalMessages: storedTurns.length,
        totalSummaryNodes: 0,
        maxDepth: 1,
      };
    },
    async destroy(): Promise<void> {},
  };

  await assert.rejects(
    () =>
      memoryArenaRunner.run(system as never, {
        datasetDir,
        limit: 1,
      }),
    /MemoryArena task bundled_shopping:1 is missing answer index 0/,
  );

  assert.equal(
    storedTurns.some((turn) => /Answer for subtask/.test(turn.content)),
    false,
  );
});
