import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchResponder,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();

  constructor(readonly responder?: BenchResponder) {}

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

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function toCsv(headers: string[], values: string[]): string {
  return `${headers.join(",")}\n${values.map(escapeCsvField).join(",")}\n`;
}

test("runBenchmark executes personamem in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("personamem", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "personamem");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(
    result.results.tasks[0]?.actual.includes("Earl Grey"),
    true,
  );
  assert.equal(result.results.tasks[0]?.expected, "Earl Grey");
});

test("runBenchmark executes personamem in full mode from an explicit dataset root", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const adapter = new FakeMemoryAdapter();
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });

  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      metadata: { persona_id: "persona-1" },
      chat_history: [
        {
          role: "system",
          content: "You are a personalized assistant.",
        },
        {
          role: "user",
          content: "I like to journal every morning with a mug of Earl Grey tea.",
        },
        {
          role: "assistant",
          content: "Noted: journaling pairs with Earl Grey tea for you.",
        },
      ],
    }),
    "utf8",
  );

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "expanded_persona",
        "user_query",
        "correct_answer",
      ],
      [
        "persona-1",
        "data/chat_history_32k/persona-1.json",
        "{\n  \"preferences\": [\"tea\", \"journaling\"],\n  \"note\": \"contains a comma, too\"\n}",
        "{'role': 'user', 'content': 'Which tea do I usually drink while journaling in the morning?'}",
        "Earl Grey",
      ],
    ),
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(
    result.results.tasks[0]?.question,
    "Which tea do I usually drink while journaling in the morning?",
  );
  assert.equal(result.results.tasks[0]?.expected, "Earl Grey");
  assert.equal(
    result.results.tasks[0]?.actual.includes("Earl Grey"),
    true,
  );
});

test("runBenchmark scores personamem with official-style MCQ accuracy when distractors are present", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-mcq-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  let promptSeen = "";
  const adapter = new FakeMemoryAdapter({
    async respond(question, recalledText) {
      promptSeen = question;
      assert.match(question, /Please choose the best answer/);
      assert.match(question, /Please recall my related preferences/);
      assert.match(recalledText, /Earl Grey/);
      return {
        text: "The history points to the tea option.\n\nFinal Answer: A",
        tokens: { input: 10, output: 8 },
        latencyMs: 3,
        model: "fake-responder",
      };
    },
  });
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });

  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      metadata: { persona_id: "persona-1" },
      chat_history: [
        {
          role: "user",
          content: "I like to journal every morning with a mug of Earl Grey tea.",
        },
      ],
    }),
    "utf8",
  );

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "user_query",
        "correct_answer",
        "incorrect_answers",
      ],
      [
        "persona-1",
        "data/chat_history_32k/persona-1.json",
        "{'role': 'user', 'content': 'Which tea do I usually drink while journaling?'}",
        "Earl Grey",
        JSON.stringify(["coffee", "peppermint"]),
      ],
    ),
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    seed: 0,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.mcq_accuracy, 1);
  assert.equal(result.results.aggregates.mcq_accuracy?.mean, 1);
  assert.equal(task.details?.evaluationMode, "mcq");
  assert.equal(task.details?.correctMcqOption, "A");
  assert.equal(task.details?.predictedMcqOption, "A");
  assert.deepEqual(task.details?.mcqOptions, {
    A: "Earl Grey",
    B: "coffee",
    C: "peppermint",
  });
  assert.match(promptSeen, /Final Answer: \[Letter\]/);
});

test("runBenchmark rejects personamem full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("personamem", {
        mode: "full",
        system: adapter,
      }),
    /PersonaMem-v2 full mode requires datasetDir/,
  );
});

test("runBenchmark rejects personamem chat history links that escape the dataset root", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-escape-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const outsideDir = path.join(tmpDir, "outside");
  const adapter = new FakeMemoryAdapter();
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(
    path.join(outsideDir, "persona-1.json"),
    JSON.stringify({
      chat_history: [{ role: "user", content: "I prefer oolong tea." }],
    }),
    "utf8",
  );

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "user_query",
        "correct_answer",
      ],
      [
        "persona-1",
        "../../outside/persona-1.json",
        "{'role': 'user', 'content': 'Which tea do I prefer?'}",
        "oolong tea",
      ],
    ),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("personamem", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must stay within datasetDir/,
  );
});

test("runBenchmark honors personamem limit before parsing later CSV rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-limit-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const adapter = new FakeMemoryAdapter();
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });

  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      chat_history: [{ role: "user", content: "I always order Earl Grey tea." }],
    }),
    "utf8",
  );

  const headers = [
    "persona_id",
    "chat_history_32k_link",
    "user_query",
    "correct_answer",
  ];
  const validRow = [
    "persona-1",
    "data/chat_history_32k/persona-1.json",
    "{'role': 'user', 'content': 'Which tea do I order?'}",
    "Earl Grey tea",
  ];
  const invalidRow = [
    "",
    "data/chat_history_32k/persona-1.json",
    "{'role': 'user', 'content': 'Which tea do I order?'}",
    "Earl Grey tea",
  ];

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    `${headers.join(",")}\n${validRow.map(escapeCsvField).join(",")}\n${invalidRow.map(escapeCsvField).join(",")}\n`,
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Earl Grey tea");
});

test("runBenchmark preserves original CSV row numbers after blank personamem rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-rows-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const adapter = new FakeMemoryAdapter();
  await mkdir(benchmarkDir, { recursive: true });

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    [
      "persona_id,chat_history_32k_link,user_query,correct_answer",
      "",
      ",data/chat_history_32k/persona-1.json,\"{'role': 'user', 'content': 'Which tea do I order?'}\",Earl Grey tea",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("personamem", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /row 3 is missing persona_id/,
  );
});
