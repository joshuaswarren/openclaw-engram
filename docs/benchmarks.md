# Remnic published-benchmark numbers

Remnic evaluates against the same two benchmarks the 2026 memory-agent
landscape converges on: **LongMemEval-S** and **LoCoMo-10**. Numbers
below come from the `docs/benchmarks/results/` artifact directory,
validated by `scripts/bench/verify-artifact.ts` before publication.

See [`docs/benchmarks/runbook.md`](./benchmarks/runbook.md) for the
exact steps. The runner plumbing is in `@remnic/bench` — notably:

- Dataset loaders: `loadLongMemEvalS()` / `loadLoCoMo10()`
  ([issue #566 slice 1](https://github.com/joshuaswarren/remnic/pull/580))
- Artifact schema: `BenchmarkArtifact` v1
  ([issue #566 slice 3](https://github.com/joshuaswarren/remnic/pull/581))
- CI regression guard: `.github/workflows/bench-smoke.yml`
  ([issue #566 slice 7](https://github.com/joshuaswarren/remnic/pull/584))

## What to expect

The first publicly-cited numbers will land in a release tagged once
slice 6 is executed end-to-end — until then, the
`docs/benchmarks/results/` directory only contains **mock placeholder
artifacts** (filename suffix `mock000`, `datasetVersion:
"mock-fixture"`) so the pipeline can be verified on a fresh clone.
**Do not cite the mock numbers publicly.**

When real numbers land they will be:

- Committed to `docs/benchmarks/results/` as `BenchmarkArtifact v1`
  JSON files (one per benchmark × model × run).
- Rendered on <https://remnic.ai/benchmarks>.
- Called out in `CHANGELOG.md` under the release that introduced them.

## Reproducibility

Every artifact records:

- `schemaVersion` + `benchmarkId` + `datasetVersion`
- `system.{name, version, gitSha}` (Remnic version + commit SHA)
- `model` + `seed`
- `startedAt` + `finishedAt` + `durationMs`
- `env.{node, os, arch?}`

To re-run a published number:

```bash
# From the repo root
git checkout <artifact.system.gitSha>
pnpm install && pnpm --filter @remnic/core run build
# Follow docs/benchmarks/runbook.md with the same --seed and --model.
```

## Ethics

- No dataset file or raw LLM trace is committed to this repo.
- No API key, credential, or private profile appears in any artifact.
- Artifact contents are validated by `parseBenchmarkArtifact()` before
  serialization; anything that fails the schema is rejected at build
  time, not silently elided.
