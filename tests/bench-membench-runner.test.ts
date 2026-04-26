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
  responder?: BenchResponder;

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
    const queryTerms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
    for (const [currentSessionId, messages] of haystack) {
      messages.forEach((message, index) => {
        const content = message.content.toLowerCase();
        if (
          content.includes(query.toLowerCase())
          || queryTerms.some((term) => content.includes(term))
        ) {
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

function createDatasetCases() {
  return [
    {
      id: "membench-dataset-1",
      memoryType: "factual",
      scenario: "participant",
      level: "surface",
      turns: [
        {
          role: "user",
          content: "I moved to Lisbon last spring to work from the waterfront.",
        },
        {
          role: "assistant",
          content: "Lisbon by the waterfront, noted.",
        },
      ],
      question: "Which city did I move to last spring?",
      answer: "Lisbon",
    },
  ];
}

function createNestedPublishedDataset() {
  return {
    conflict_patterns: [
      {
        trajectory: [
          {
            speaker: "Avery",
            text: "I moved to Porto last year to be closer to the river walk.",
          },
          {
            speaker: "Morgan",
            text: "Porto by the river walk. I'll remember that.",
          },
        ],
        qa: [
          {
            question: "Which city did Avery move to last year?",
            answer: "Porto",
          },
        ],
      },
    ],
  };
}

function createOfficialChoiceDataset() {
  return {
    factual: {
      ThirdAgentDataLowLevel: [
        {
          message_list: [
            "Avery moved to Porto last year to be closer to the river walk.",
            "Avery now lives in Porto near the river walk.",
          ],
          QA: {
            id: "official-mcq-1",
            question: "Which city did Avery move to last year?",
            time: "2026-04-01",
            choices: {
              A: "Lisbon",
              B: "Porto",
              C: "Madrid",
              D: "Seville",
            },
            answer: "B",
            target_step_id: [0],
          },
        },
      ],
    },
  };
}

function createOfficialParticipantDataset() {
  return {
    preference: {
      FirstAgentDataHighLevel: [
        {
          message_list: [
            {
              user: "I loved Alien (1979), especially the practical tension.",
              agent: "Alien (1979) fits your taste for tense sci-fi.",
            },
          ],
          QA: {
            question: "Which movie preference should the assistant remember?",
            choices: ["Toy Story", "Alien (1979)", "Heat", "Jaws"],
            answer: "Alien (1979)",
            target_step_id: [[0, 0]],
          },
        },
      ],
    },
  };
}

test("runBenchmark executes membench in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("membench", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "membench");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(result.results.tasks[0]?.expected, "Lisbon");
  assert.equal(result.results.tasks[0]?.actual.includes("Lisbon"), true);
  assert.equal(result.results.tasks[0]?.details.memoryType, "factual");
  assert.equal(result.results.tasks[1]?.details.memoryType, "reflective");
});

test("runBenchmark executes membench in full mode from an explicit dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "membench.json"),
    JSON.stringify(createDatasetCases()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Lisbon");
  assert.equal(result.results.tasks[0]?.details.scenario, "participant");
});

test("runBenchmark accepts upstream MemBench export filenames in full mode", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-upstream-name-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "FirstAgentDataLowLevel.json"),
    JSON.stringify(createDatasetCases()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Lisbon");
  assert.equal(result.results.tasks[0]?.details.memoryType, "factual");
  assert.equal(result.results.tasks[0]?.details.scenario, "participant");
});

test("runBenchmark normalizes nested published MemBench trajectory and qa structures", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-nested-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "ThirdAgentDataHighLevel.json"),
    JSON.stringify(createNestedPublishedDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Porto");
  assert.equal(result.results.tasks[0]?.question, "Which city did Avery move to last year?");
  assert.equal(result.results.tasks[0]?.details.memoryType, "reflective");
  assert.equal(result.results.tasks[0]?.details.scenario, "observation");
});

test("runBenchmark scores official MemBench multiple-choice accuracy and recall", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-mcq-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  adapter.responder = {
    async respond() {
      return {
        text: '{"choice":"B"}',
        tokens: { input: 3, output: 1 },
        latencyMs: 2,
        model: "fake-choice-model",
      };
    },
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "ThirdAgentDataLowLevel.json"),
    JSON.stringify(createOfficialChoiceDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "B");
  assert.equal(task.actual, "B");
  assert.equal(task.scores.membench_accuracy, 1);
  assert.equal(task.scores.membench_recall_at_10, 1);
  assert.equal(task.details?.correctAnswer, "Porto");
  assert.equal(task.details?.officialProtocol, "multiple_choice_accuracy");
  assert.equal(result.results.aggregates.membench_accuracy?.mean, 1);
  assert.equal(
    result.results.aggregates.membench_accuracy_factual_observation?.mean,
    1,
  );
});

test("runBenchmark accepts official first-agent message_list and QA records", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-first-agent-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  adapter.responder = {
    async respond() {
      return {
        text: "B",
        tokens: { input: 3, output: 1 },
        latencyMs: 2,
        model: "fake-choice-model",
      };
    },
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "FirstAgentDataHighLevel.json"),
    JSON.stringify(createOfficialParticipantDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "B");
  assert.equal(task.actual, "B");
  assert.equal(task.details?.memoryType, "reflective");
  assert.equal(task.details?.scenario, "participant");
  assert.equal(task.details?.turnCount, 2);
  assert.equal(task.scores.membench_accuracy, 1);
  assert.equal(
    result.results.aggregates.membench_accuracy_reflective_participant?.mean,
    1,
  );
});

test("runBenchmark rejects membench full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("membench", {
        mode: "full",
        system: adapter,
      }),
    /MemBench full mode requires datasetDir/,
  );
});

test("runBenchmark treats membench limit zero as an empty run instead of falling back to all cases", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("membench", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /MemBench dataset is empty after applying the requested limit/,
  );
});
