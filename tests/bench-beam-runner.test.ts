import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(sessionId: string, _query: string): Promise<string> {
    return (this.sessions.get(sessionId) ?? [])
      .map((message) => message.content)
      .join("\n");
  }

  async search(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<SearchResult[]> {
    const haystack = sessionId
      ? [[sessionId, this.sessions.get(sessionId) ?? []] as const]
      : [...this.sessions.entries()];

    const results: SearchResult[] = [];
    for (const [currentSessionId, messages] of haystack) {
      messages.forEach((message, index) => {
        if (message.content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            turnIndex: index,
            role: message.role,
            snippet: message.content,
            sessionId: currentSessionId,
            score: 1,
          });
        }
      });
    }

    return results.slice(0, limit);
  }

  async reset(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.sessions.delete(sessionId);
      return;
    }
    this.sessions.clear();
  }

  async getStats(): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
  }> {
    const totalMessages = [...this.sessions.values()].reduce(
      (sum, messages) => sum + messages.length,
      0,
    );

    return {
      totalMessages,
      totalSummaryNodes: 0,
      maxDepth: 1,
    };
  }

  async destroy(): Promise<void> {}
}

test("runBenchmark executes beam in quick mode with the bundled smoke fixture", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("beam", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "beam");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 4);
  assert.equal(result.results.tasks[0]?.expected, "March 29");
  assert.equal(result.results.tasks[0]?.actual.includes("March 29"), true);
  assert.equal(result.results.tasks[0]?.details.ability, "information_extraction");
  assert.equal(result.results.tasks[0]?.details.scale, "100K");
  assert.equal(typeof result.results.aggregates.rouge_l?.mean, "number");
  assert.equal(typeof result.results.aggregates.search_hits?.mean, "number");
});

test("runBenchmark loads beam full-mode datasets and includes 10M plan chats in recall", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  const conversation = [
    {
      conversation_id: "beam-full-10m-1",
      chat: [
        [
          {
            id: 1,
            role: "user",
            content: "The main thread is about preparing the release checklist.",
          },
        ],
      ],
      plans: [
        {
          plan_id: "plan-0",
          chat: [
            [
              {
                id: 101,
                role: "user",
                content: "Micah owns the final deployment sign-off for the 10M plan.",
              },
            ],
          ],
        },
      ],
      probing_questions:
        "{'knowledge_update': [{'question': 'Who owns the final deployment sign-off?', 'answer': 'Micah', 'difficulty': 'easy', 'rubric': ['LLM response should state: Micah']}]}",
    },
  ];

  await writeFile(
    path.join(datasetDir, "10M.json"),
    JSON.stringify(conversation),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Micah");
  assert.equal(result.results.tasks[0]?.actual.includes("Micah"), true);
  assert.equal(result.results.tasks[0]?.details.scale, "10M");
  assert.equal(result.results.tasks[0]?.details.sessionCount, 2);
});

test("runBenchmark rejects beam full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("beam", {
        mode: "full",
        system: adapter,
      }),
    /BEAM full mode requires datasetDir/,
  );
});

test("runBenchmark rejects empty beam datasets after applying limit", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("beam", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /BEAM dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark rejects beam datasets with mixed chat nesting", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-mixed-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-mixed-1",
        chat: [
          {
            id: 1,
            role: "user",
            content: "This top-level array mixes turns and batches.",
          },
          [
            {
              id: 2,
              role: "assistant",
              content: "This nested batch should be rejected.",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Who spoke in the second turn?",
              answer: "assistant",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("beam", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include chat data as a list of turns or turn batches/,
  );
});
