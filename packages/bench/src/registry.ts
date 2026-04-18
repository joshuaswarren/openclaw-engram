/**
 * Published benchmark registry for @remnic/bench phase 1.
 */

import type { BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions } from "./types.js";
import {
  longMemEvalDefinition,
  runLongMemEvalBenchmark,
} from "./benchmarks/published/longmemeval/runner.js";

interface RegisteredBenchmark extends BenchmarkDefinition {
  run?: (options: ResolvedRunBenchmarkOptions) => Promise<BenchmarkResult>;
}

const REGISTERED_BENCHMARKS: RegisteredBenchmark[] = [
  {
    id: "ama-bench",
    title: "AMA-Bench",
    tier: "published",
    status: "planned",
    runnerAvailable: false,
    meta: {
      name: "ama-bench",
      version: "1.0.0",
      description: "Long-horizon agentic memory benchmark.",
      category: "agentic",
    },
  },
  {
    id: "memory-arena",
    title: "MemoryArena",
    tier: "published",
    status: "planned",
    runnerAvailable: false,
    meta: {
      name: "memory-arena",
      version: "1.0.0",
      description: "Interdependent multi-session task benchmark.",
      category: "agentic",
    },
  },
  {
    id: "amemgym",
    title: "AMemGym",
    tier: "published",
    status: "planned",
    runnerAvailable: false,
    meta: {
      name: "amemgym",
      version: "1.0.0",
      description: "Interactive personalization benchmark.",
      category: "agentic",
    },
  },
  {
    ...longMemEvalDefinition,
    run: runLongMemEvalBenchmark,
  },
  {
    id: "locomo",
    title: "LoCoMo",
    tier: "published",
    status: "planned",
    runnerAvailable: false,
    meta: {
      name: "locomo",
      version: "1.0.0",
      description: "Long conversation memory benchmark.",
      category: "conversational",
    },
  },
];

export function listBenchmarks(): BenchmarkDefinition[] {
  return REGISTERED_BENCHMARKS.map(stripRuntimeFields);
}

export function getBenchmark(id: string): BenchmarkDefinition | undefined {
  const benchmark = REGISTERED_BENCHMARKS.find((candidate) => candidate.id === id);
  return benchmark ? stripRuntimeFields(benchmark) : undefined;
}

export function getRegisteredBenchmark(
  id: string,
): RegisteredBenchmark | undefined {
  return REGISTERED_BENCHMARKS.find((candidate) => candidate.id === id);
}

function stripRuntimeFields(benchmark: RegisteredBenchmark): BenchmarkDefinition {
  return {
    id: benchmark.id,
    title: benchmark.title,
    tier: benchmark.tier,
    status: benchmark.status,
    runnerAvailable: benchmark.runnerAvailable,
    meta: benchmark.meta,
  };
}
