#!/usr/bin/env tsx
/**
 * Engram Eval Suite — CLI entrypoint.
 *
 * Usage:
 *   tsx evals/run.ts --benchmark <name|all> [options]
 *
 * Adapter modes:
 *   (default)        Full-stack sandboxed Orchestrator (all Engram features)
 *   --lightweight     LCM + FTS only (no LLM/QMD needed, CI-friendly)
 *   --mcp            MCP HTTP adapter (against running Engram server)
 */

import path from "node:path";
import { createEngramAdapter, createLightweightAdapter } from "./adapter/engram-adapter.js";
import { createMcpAdapter } from "./adapter/mcp-adapter.js";
import { createCmcAdapter } from "./adapter/cmc-adapter.js";
import type { BenchmarkRunner, MemorySystem } from "./adapter/types.js";
import { amaBenchRunner } from "./benchmarks/ama-bench/runner.js";
import { memoryArenaRunner } from "./benchmarks/memory-arena/runner.js";
import { amemGymRunner } from "./benchmarks/amemgym/runner.js";
import { longMemEvalRunner } from "./benchmarks/longmemeval/runner.js";
import { locomoRunner } from "./benchmarks/locomo/runner.js";
import { writeResult, printSummary } from "./reporter.js";

const RUNNERS: Record<string, BenchmarkRunner> = {
  "ama-bench": amaBenchRunner,
  "memory-arena": memoryArenaRunner,
  amemgym: amemGymRunner,
  longmemeval: longMemEvalRunner,
  locomo: locomoRunner,
};

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Engram Eval Suite

Usage: tsx evals/run.ts --benchmark <name|all> [options]

Benchmarks:
  ama-bench       Agent Memory Abilities (agentic)
  memory-arena    Interdependent agentic tasks (agentic)
  amemgym         Interactive personalization (agentic)
  longmemeval     Long-term memory retrieval (retrieval)
  locomo          Long conversation memory (conversational)
  all             Run all benchmarks

Adapter modes:
  (default)              Full-stack sandboxed Orchestrator — exercises ALL
                         Engram features (extraction, QMD search, recall planner,
                         LCM, entity retrieval, etc). Requires LLM + QMD access.
  --lightweight          LCM engine + FTS5 only — no external services needed.
                         Use for CI or environments without LLM/QMD.
  --mcp                  MCP HTTP adapter — connects to a running Engram server.
                         Exercises the exact same stack agents use in production.

Options:
  --mcp-url <url>        MCP server URL (default: http://localhost:18789)
  --mcp-token <token>    MCP auth token
  --limit <n>            Max tasks per benchmark
  --output-dir <path>    Results directory (default: evals/results)
  --judge                Enable LLM judge scoring (uses gateway model chain;
                         adds ~15s/question, off by default for speed)
`);
    return;
  }

  const benchmarkName = readArg("--benchmark");
  if (!benchmarkName) {
    console.error("ERROR: --benchmark is required. Use --help for usage.");
    process.exitCode = 1;
    return;
  }

  const useMcp = hasFlag("--mcp");
  const useLightweight = hasFlag("--lightweight");
  const useCmc = hasFlag("--cmc");
  const useCmcFull = hasFlag("--cmc-full");
  const useJudge = hasFlag("--judge");
  const mcpUrl = readArg("--mcp-url") ?? "http://localhost:18789";
  const mcpToken = readArg("--mcp-token");
  const limitStr = readArg("--limit");
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;
  const outputDir =
    readArg("--output-dir") ??
    path.resolve(import.meta.dirname, "results");
  const datasetsDir = path.resolve(import.meta.dirname, "datasets");

  // Determine which benchmarks to run
  const benchmarkNames =
    benchmarkName === "all"
      ? Object.keys(RUNNERS)
      : [benchmarkName];

  for (const name of benchmarkNames) {
    if (!RUNNERS[name]) {
      console.error(`ERROR: Unknown benchmark "${name}". Available: ${Object.keys(RUNNERS).join(", ")}, all`);
      process.exitCode = 1;
      return;
    }
  }

  // Create adapter
  let system: MemorySystem;
  let adapterMode: "direct" | "mcp";

  if (useMcp) {
    adapterMode = "mcp";
    console.log(`Adapter: MCP HTTP at ${mcpUrl}`);
    system = await createMcpAdapter({ baseUrl: mcpUrl, authToken: mcpToken });
  } else if (useCmcFull) {
    adapterMode = "direct";
    console.log("Adapter: Full-stack Orchestrator + CMC (all Engram features + CMC enabled)");
    system = await createEngramAdapter({
      configOverrides: {
        cmcEnabled: true,
        cmcStitchLookbackDays: 30,
        cmcStitchMinScore: 1.5,
        cmcStitchMaxEdgesPerTrajectory: 5,
        cmcConsolidationEnabled: true,
        cmcConsolidationMinRecurrence: 2,
        cmcConsolidationMinSessions: 1,
        cmcRetrievalEnabled: true,
        cmcRetrievalMaxDepth: 3,
        cmcRetrievalMaxChars: 1200,
        cmcRetrievalCounterfactualBoost: 0.4,
        cmcBehaviorLearningEnabled: true,
        cmcBehaviorMinFrequency: 2,
        cmcBehaviorMinSessions: 1,
        cmcBehaviorConfidenceThreshold: 0.4,
        cmcLifecycleCausalImpactWeight: 0.05,
      },
    });
  } else if (useCmc) {
    adapterMode = "direct";
    console.log("Adapter: CMC-enhanced (LCM + FTS + IRC + CMC, no LLM needed)");
    system = await createCmcAdapter();
  } else if (useLightweight) {
    adapterMode = "direct";
    console.log("Adapter: Lightweight (LCM + FTS only, no external services)");
    system = await createLightweightAdapter();
  } else {
    adapterMode = "direct";
    console.log("Adapter: Full-stack sandboxed Orchestrator (all Engram features)");
    console.log("  (use --lightweight for CI without LLM/QMD access)");
    system = await createEngramAdapter();
  }

  // Disable LLM judge unless explicitly requested (adds ~15s/question)
  if (!useJudge && system.judge) {
    console.log("  (LLM judge disabled — use --judge to enable semantic scoring)");
    system.judge = undefined;
  } else if (useJudge && system.judge) {
    console.log("  LLM judge: enabled (gateway model chain)");
  } else if (useJudge && !system.judge) {
    console.log("  WARNING: --judge requested but no LLM available (gateway config not found?)");
  }

  let hasFailure = false;

  try {
    for (const name of benchmarkNames) {
      const runner = RUNNERS[name];
      const datasetDir = path.join(datasetsDir, name);

      console.log(`\nRunning: ${runner.meta.name} (${runner.meta.category})...`);

      try {
        const result = await runner.run(system, {
          limit,
          datasetDir,
        });
        result.adapterMode = adapterMode;

        const filePath = await writeResult(result, outputDir);
        printSummary(result);
        console.log(`Results saved: ${filePath}`);
      } catch (err) {
        console.error(`ERROR running ${name}: ${err instanceof Error ? err.message : err}`);
        hasFailure = true;
      }
    }
  } finally {
    await system.destroy();
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
