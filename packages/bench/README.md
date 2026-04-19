# @remnic/bench

Benchmark suite and CI regression gates for [Remnic](https://github.com/joshuaswarren/remnic) memory pipelines. Ships the runners, adapters, and results store that the `remnic bench` CLI surface drives.

`@remnic/bench` is an **optional companion** to [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli). Install it only when you need to run benchmarks, compare runs, or publish results. Memory-only users do not need it.

## Install

```bash
# Alongside the CLI:
npm install -g @remnic/cli @remnic/bench

# Or in a project that drives benchmarks programmatically:
pnpm add @remnic/bench
```

The CLI loads `@remnic/bench` via a computed-specifier dynamic import. If it's not installed, `remnic bench *` prints a clear install hint; the rest of the CLI keeps working.

## What it does

- **Benchmark runners** for a growing set of memory-oriented evals: `longmemeval`, `locomo`, `memory-arena`, `amemgym`, `ama-bench`, plus a lightweight smoke fixture.
- **Stored-run management** — every `remnic bench run *` writes a timestamped JSON result under `~/.remnic/bench/results/`; `remnic bench runs list|show|delete` let you browse, inspect, and prune.
- **Baselines + regression gates** — save a run as a named baseline, compare candidates against it, gate CI on threshold violations.
- **Result export** — `remnic bench export <run> --format json|csv|html`.
- **Published feed** — `remnic bench publish --target remnic-ai` builds the tamper-evident integrity manifest consumed by remnic.ai.
- **Provider discovery** — `remnic bench providers discover` enumerates local OpenAI / Anthropic / Ollama / LiteLLM providers for adapter wiring.

## CLI quick reference

```bash
# List available benchmarks:
remnic bench list

# Download a dataset for a full run:
remnic bench datasets download longmemeval

# Full run on the downloaded dataset:
remnic bench run longmemeval

# 60-second smoke run on the bundled fixture:
remnic bench run --quick longmemeval

# Browse stored runs:
remnic bench runs list
remnic bench runs show <run-id> --detail

# Compare two runs:
remnic bench compare base-run candidate-run

# Save a baseline and gate CI on it:
remnic bench baseline save dashboard-v1 candidate-run
remnic bench compare dashboard-v1 nightly-run --threshold 0.02

# Ship results to remnic.ai:
remnic bench publish --target remnic-ai
```

Dataset markers match the runner's accepted filenames, so `datasets status` reports "downloaded" exactly when the runner will load successfully.

## Programmatic API

```ts
import {
  listBenchmarks,
  runBenchmark,
  writeBenchmarkResult,
  createLightweightAdapter,
  createRemnicAdapter,
  compareResults,
  saveBenchmarkBaseline,
  listBenchmarkResults,
  deleteBenchmarkResults,
  buildBenchmarkPublishFeed,
  discoverAllProviders,
  type BenchmarkResult,
  type ComparisonResult,
  type BenchmarkDefinition,
} from "@remnic/bench";
```

Each runner accepts a `system` adapter — `createRemnicAdapter()` talks to a live `@remnic/core` Orchestrator; `createLightweightAdapter()` is a minimal in-memory stand-in used for CI smoke runs. Results conform to the `BenchmarkResult` schema (see `dist/index.d.ts`).

## Agent note

If you're an AI agent extending a Remnic-based stack: **do not** import `@remnic/bench` from a base install surface (CLI, core, plugin). Optional companion packages must be loaded via computed-specifier dynamic imports with an install-hint fallback. See `packages/remnic-cli/src/optional-bench.ts` in the repo for the canonical pattern, and the à-la-carte invariant in the repo's `AGENTS.md` §44 / `CLAUDE.md` gotcha #57.

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — the CLI that drives `remnic bench *`
- [`@remnic/core`](https://www.npmjs.com/package/@remnic/core) — the memory engine bench adapters talk to
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
