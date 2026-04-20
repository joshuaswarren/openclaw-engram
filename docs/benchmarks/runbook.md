# Remnic published-benchmark runbook

This runbook documents how to produce the LongMemEval-S + LoCoMo-10 numbers
published at <https://remnic.ai/benchmarks>. It is the human-executable
companion to issue #566 slice 6. Every step must be runnable from a fresh
clone on a machine with appropriate API keys; nothing auto-runs on CI.

> **Do not commit real user data.** The repository is public. Only the
> runner aggregates + per-task scores land in `docs/benchmarks/results/`.
> Never commit raw dataset files, API keys, or intermediate LLM traces.

## 1. Prerequisites

- Node.js ≥ 22.12.0 and `pnpm` 10+.
- `huggingface-cli` (install via `pipx install "huggingface_hub[cli]"` or
  `brew install huggingface-cli`). LongMemEval and LoCoMo download from
  HuggingFace datasets.
- An OpenAI API key for the cloud run, exposed as `OPENAI_API_KEY`.
- For the local-LLM parity run (slice 5, future): a local llama.cpp or
  vLLM server already serving a model at an `http(s)://...` URL.

## 2. One-time setup

```bash
pnpm install
pnpm --filter @remnic/core run build
pnpm --filter @remnic/bench run build

# Print the HuggingFace download commands for the published datasets.
# The script does NOT auto-download; copy-paste the commands it prints.
scripts/bench/fetch-datasets.sh --target ./bench-datasets
```

Expected layout after following the printed commands:

```
bench-datasets/
  longmemeval/
    longmemeval_oracle.json          # preferred
    longmemeval_s_cleaned.json       # optional alternate
  locomo/
    locomo10.json                    # preferred
```

`bench-datasets/` is gitignored. Never commit it.

## 3. Run LongMemEval-S on gpt-4o-mini

```bash
OPENAI_API_KEY=... \
pnpm exec remnic bench published \
  --name longmemeval \
  --dataset ./bench-datasets/longmemeval \
  --model gpt-4o-mini \
  --limit 100 \
  --seed 42 \
  --out docs/benchmarks/results/
```

The runner:

1. Loads LongMemEval-S via `loadLongMemEvalS()` (slice 1).
2. Resets the Remnic orchestrator for each item.
3. Ingests every haystack session.
4. Recalls + answers each question via the configured responder.
5. Scores via `f1`, `contains_answer`, and the LLM judge (configurable).
6. Emits a `BenchmarkArtifact` JSON (slice 3) under
   `docs/benchmarks/results/<iso-date>-longmemeval-<model>-<sha>.json`.

## 4. Run LoCoMo-10 on gpt-4o-mini

```bash
OPENAI_API_KEY=... \
pnpm exec remnic bench published \
  --name locomo \
  --dataset ./bench-datasets/locomo \
  --model gpt-4o-mini \
  --seed 42 \
  --out docs/benchmarks/results/
```

Metrics emitted: `f1`, `contains_answer`, `rouge_l`, optional `llm_judge`.

## 5. Verify artifacts before publishing

```bash
# Each artifact is validated + re-hashed. Exits non-zero on mismatch.
pnpm exec tsx scripts/bench/verify-artifact.ts \
  docs/benchmarks/results/*.json
```

The output line for each artifact shape is:

```
OK <filename> <benchmark> model=<id> seed=<n> metrics=<k>=<v>,<k>=<v>,... sha256=<hex>
```

## 6. Publish

Artifacts are committed to `docs/benchmarks/results/`. The site
(`packages/remnic-site`) reads the directory at build time and renders
the `/benchmarks` leaderboard page. A release of Remnic publishes the
site + artifacts together.

Between releases, `docs/benchmarks/results/` is git-tracked by default
so incremental numbers are visible on the main branch. Individual runs
can be excluded from the commit if they are experimental / not ready
for public display.

## 7. Local-LLM parity run (slice 5, when shipped)

```bash
pnpm exec remnic bench published \
  --name longmemeval \
  --dataset ./bench-datasets/longmemeval \
  --provider local-llm \
  --base-url http://127.0.0.1:8080 \
  --model llama-3.1-8b-instruct-q4_k_m \
  --seed 42 \
  --out docs/benchmarks/results/
```

The same runner + artifact schema as the cloud run. Only the responder /
extraction provider differ.

## 8. Troubleshooting

- **`LongMemEval dataset not found under ./bench-datasets/longmemeval`**
  Rerun `scripts/bench/fetch-datasets.sh --target ./bench-datasets` and
  copy-paste the printed `huggingface-cli` commands.
- **`parseBenchmarkArtifact: schemaVersion <N> is not supported`**
  The artifact was written by a newer version of `@remnic/bench`.
  Either update the local checkout or inspect the newer schema.
- **LLM judge returns 0 on everything**
  Set `BENCH_JUDGE_MODEL` + `BENCH_JUDGE_PROVIDER` explicitly. The
  default judge hits whatever the adapter's evaluator LLM is — ensure
  it has access to the expected question/predicted/expected fields.

## 9. Mocked example

`docs/benchmarks/results/2026-04-20-longmemeval-gpt-4o-mini-mock000.json`
and `.../2026-04-20-locomo-gpt-4o-mini-mock000.json` are **example**
artifacts with placeholder scores, committed so the leaderboard page
has something to render on a fresh clone. They are clearly marked
`datasetVersion: "mock-fixture"` and the filename sha segment is
`mock000`. Replace them with real artifacts produced via steps 3-5 once
the full run is executed. **Do not cite the mock numbers publicly.**
