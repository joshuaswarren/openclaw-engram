#!/usr/bin/env -S npx tsx
/**
 * bench-smoke.ts — Deterministic, side-effect-free smoke harness that
 * exercises the LongMemEval + LoCoMo published-benchmark runners
 * against their bundled smoke fixtures. Intended for CI regression
 * guarding only — do NOT run this against real datasets or real LLMs.
 *
 * The smoke harness uses:
 *   - The runner's built-in `LONG_MEM_EVAL_SMOKE_FIXTURE` and
 *     `LOCOMO_SMOKE_FIXTURE` (no network, no dataset files).
 *   - A deterministic in-memory adapter that echoes the stored
 *     messages back on recall/search.
 *   - A deterministic responder that returns the `recalledText`
 *     verbatim so scoring is reproducible (`contains_answer` + `f1`).
 *   - A deterministic judge that returns a fixed score.
 *
 * Usage:
 *   scripts/bench/bench-smoke.ts --seed 1 \
 *     --baseline tests/fixtures/bench-smoke/baseline.json
 *   scripts/bench/bench-smoke.ts --seed 1 --update-baseline
 *
 * Exit codes:
 *   0 — all metrics within tolerance
 *   1 — regression detected OR CLI usage error
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  locomoDefinition,
  runLoCoMoBenchmark,
} from "../../packages/bench/src/benchmarks/published/locomo/runner.js";
import {
  longMemEvalDefinition,
  runLongMemEvalBenchmark,
} from "../../packages/bench/src/benchmarks/published/longmemeval/runner.js";
import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchResponder,
  Message,
  SearchResult,
} from "../../packages/bench/src/adapters/types.js";

// Tolerance for each metric. Issue #566 spec: fail if score drops > 5% vs
// committed baseline. We compare per-metric means; higher-is-better
// metrics regress when current < baseline - 0.05.
const REGRESSION_TOLERANCE = 0.05;

interface SmokeBaseline {
  schemaVersion: 1;
  /**
   * Baseline metrics keyed by benchmark ID. Intentionally carries NO
   * timestamp so the committed file is stable across runs — CI
   * compares the current metrics against these numbers.
   */
  benchmarks: Record<
    string,
    {
      metrics: Record<string, number>;
    }
  >;
}

interface CliArgs {
  seed: number;
  baselinePath: string;
  updateBaseline: boolean;
  tolerance: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let seed = 1;
  let baselinePath = path.resolve(
    process.cwd(),
    "tests/fixtures/bench-smoke/baseline.json",
  );
  let updateBaseline = false;
  let tolerance = REGRESSION_TOLERANCE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--seed": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--seed requires an integer argument");
        }
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`--seed must be a non-negative integer; got ${value}`);
        }
        seed = parsed;
        index += 1;
        break;
      }
      case "--baseline": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--baseline requires a file path");
        }
        baselinePath = path.resolve(process.cwd(), value);
        index += 1;
        break;
      }
      case "--tolerance": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--tolerance requires a number");
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(
            `--tolerance must be a non-negative number; got ${value}`,
          );
        }
        tolerance = parsed;
        index += 1;
        break;
      }
      case "--update-baseline":
        updateBaseline = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(
          `Unknown argument: ${arg}. Run --help for usage.`,
        );
    }
  }

  return { seed, baselinePath, updateBaseline, tolerance };
}

function printUsage(): void {
  process.stdout.write(
    [
      "bench-smoke.ts — LongMemEval + LoCoMo smoke regression gate",
      "",
      "Usage:",
      "  scripts/bench/bench-smoke.ts [--seed N] [--baseline PATH] [--tolerance N] [--update-baseline]",
      "",
      "Flags:",
      "  --seed N             RNG seed (default 1)",
      "  --baseline PATH      Baseline JSON path (default tests/fixtures/bench-smoke/baseline.json)",
      "  --tolerance N        Max allowed metric drop (default 0.05)",
      "  --update-baseline    Overwrite the baseline JSON with current run",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Deterministic adapter + responder + judge
// ---------------------------------------------------------------------------

function createDeterministicAdapter(): BenchMemoryAdapter {
  const store = new Map<string, Message[]>();
  const responder: BenchResponder = {
    async respond(_question, recalledText) {
      // Echo the recalled text verbatim so scoring is deterministic.
      return {
        text: recalledText,
        model: "smoke-responder",
        latencyMs: 0,
        tokens: { input: 0, output: 0 },
      };
    },
  };
  const judge: BenchJudge = {
    async score() {
      return 1;
    },
    async scoreWithMetrics() {
      return {
        score: 1,
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
        model: "smoke-judge",
      };
    },
  };

  return {
    responder,
    judge,
    async store(sessionId, messages) {
      store.set(sessionId, [...messages]);
    },
    async recall(sessionId) {
      const messages = store.get(sessionId) ?? [];
      return messages.map((message) => message.content).join("\n");
    },
    async search(query, limit) {
      const results: SearchResult[] = [];
      const lowered = query.toLowerCase();
      for (const [sessionId, messages] of store) {
        for (let turnIndex = 0; turnIndex < messages.length; turnIndex += 1) {
          const message = messages[turnIndex]!;
          if (
            typeof message.content === "string" &&
            message.content.toLowerCase().includes(lowered)
          ) {
            results.push({
              turnIndex,
              role: message.role,
              snippet: message.content,
              sessionId,
              score: 1,
            });
            if (results.length >= limit) {
              return results;
            }
          }
        }
      }
      return results;
    },
    async reset() {
      store.clear();
    },
    async destroy() {
      store.clear();
    },
    async getStats() {
      return {
        totalMessages: [...store.values()].reduce(
          (total, messages) => total + messages.length,
          0,
        ),
        totalSummaryNodes: 0,
        maxDepth: 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `bench-smoke: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    printUsage();
    return 1;
  }

  const adapter = createDeterministicAdapter();

  process.stdout.write(
    `bench-smoke: running LongMemEval + LoCoMo smoke fixtures (seed=${args.seed})\n`,
  );

  const longmemeval = await runLongMemEvalBenchmark({
    benchmark: longMemEvalDefinition,
    mode: "quick",
    seed: args.seed,
    system: adapter,
  });

  const locomo = await runLoCoMoBenchmark({
    benchmark: locomoDefinition,
    mode: "quick",
    seed: args.seed,
    system: adapter,
  });

  const current: SmokeBaseline = {
    schemaVersion: 1,
    benchmarks: {
      longmemeval: { metrics: extractMetrics(longmemeval.results.aggregates) },
      locomo: { metrics: extractMetrics(locomo.results.aggregates) },
    },
  };

  if (args.updateBaseline) {
    await writeFile(
      args.baselinePath,
      JSON.stringify(current, null, 2) + "\n",
      "utf8",
    );
    process.stdout.write(
      `bench-smoke: wrote baseline → ${args.baselinePath}\n`,
    );
    return 0;
  }

  let baseline: SmokeBaseline;
  try {
    baseline = JSON.parse(
      await readFile(args.baselinePath, "utf8"),
    ) as SmokeBaseline;
  } catch (error) {
    process.stderr.write(
      `bench-smoke: failed to read baseline from ${args.baselinePath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(
      "bench-smoke: run with --update-baseline to generate one.\n",
    );
    return 1;
  }

  const regressions: string[] = [];
  for (const [benchmarkId, bench] of Object.entries(current.benchmarks)) {
    const baselineMetrics = baseline.benchmarks[benchmarkId]?.metrics ?? {};
    for (const [metric, value] of Object.entries(bench.metrics)) {
      const baselineValue = baselineMetrics[metric];
      if (baselineValue === undefined) {
        process.stdout.write(
          `bench-smoke: [${benchmarkId}] ${metric}=${value.toFixed(4)} (new metric, no baseline)\n`,
        );
        continue;
      }
      const delta = value - baselineValue;
      const verdict =
        delta < -args.tolerance
          ? `REGRESSION (tol=${args.tolerance})`
          : "ok";
      process.stdout.write(
        `bench-smoke: [${benchmarkId}] ${metric} baseline=${baselineValue.toFixed(4)} current=${value.toFixed(4)} delta=${delta >= 0 ? "+" : ""}${delta.toFixed(4)} ${verdict}\n`,
      );
      if (delta < -args.tolerance) {
        regressions.push(
          `${benchmarkId}.${metric} dropped ${Math.abs(delta).toFixed(4)} (baseline=${baselineValue.toFixed(4)}, current=${value.toFixed(4)}, tolerance=${args.tolerance})`,
        );
      }
    }
  }

  if (regressions.length > 0) {
    process.stderr.write(
      `\nbench-smoke: REGRESSION detected (${regressions.length} metric${regressions.length === 1 ? "" : "s"}):\n`,
    );
    for (const regression of regressions) {
      process.stderr.write(`  - ${regression}\n`);
    }
    process.stderr.write(
      "\nIf this drop is intentional, re-run with --update-baseline.\n",
    );
    return 1;
  }

  process.stdout.write("\nbench-smoke: all metrics within tolerance\n");
  return 0;
}

function extractMetrics(
  aggregates: Record<string, { mean: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(aggregates).sort()) {
    const mean = aggregates[key]?.mean;
    if (typeof mean === "number" && Number.isFinite(mean)) {
      out[key] = Number(mean.toFixed(6));
    }
  }
  return out;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `bench-smoke crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
