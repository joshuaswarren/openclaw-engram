# Procedural memory

Procedural memories are first-class **`category: procedure`** items stored under `memoryDir/procedures/YYYY-MM-DD/` as markdown (same persistence path as other memories via `StorageManager.writeMemory`). They capture ordered **steps** (human-editable in the body) plus YAML frontmatter for lifecycle, provenance, and review state.

This feature tracks [issue #519](https://github.com/joshuaswarren/remnic/issues/519).

Also indexed from the repo [README](../README.md) (Features + Configuration), [Getting started](getting-started.md) (Next steps), and [Config reference](config-reference.md) (Procedural memory section) so operators and agents see the **`procedural.enabled`** gate without opening this page first.

## Enablement

Everything behavioral is gated by plugin config **`procedural.enabled`** (default **`false`**). When disabled:

- Direct extraction does not emit new procedure memories.
- Intent-gated recall does not inject a procedure section.
- The nightly miner MCP entry returns without writing files.

Mirror the same keys under `openclaw.plugin.json` / host config as for other Engram-style toggles.

## Taxonomy and filing

- `MemoryCategory` includes `"procedure"`.
- Default taxonomy exposes a **`procedures`** bucket (priority between principles and entities).
- `category-dir` maps `procedure` → `procedures/`.

## Extraction (user-taught workflows)

When the extractor proposes `category: "procedure"`, the **extraction judge** requires at least **two steps** and **explicit trigger-style** phrasing before the memory is accepted. Failed checks drop the candidate rather than downgrading silently.

## Recall (task initiation)

On prompts that look like **starting hands-on work** (deploy, ship, open a PR, run tests, etc.), the orchestrator may inject a **`## Relevant procedures`** block built from **active** procedure files only. **`pending_review`** miner suggestions are not injected by default.

Relevant config keys include:

- `procedural.recallMaxProcedures` — cap on injected procedure previews.

See also: [Advanced retrieval](./advanced-retrieval.md) and [Retrieval pipeline](./architecture/retrieval-pipeline.md).

## Mining (trajectories)

A dedicated miner clusters **causal trajectory** records (bounded lookback by `recordedAt` / `lookbackDays`) and can write **`status: pending_review`** procedure candidates. Promotion to **`active`** respects optional auto-promote rules and avoids clobbering user-edited bodies.

Automation is **not** part of `runMemoryGovernance`. Use the MCP tool **`engram.procedure_mining_run`** (and optional cron registration mirroring other nightly jobs) so procedural mining stays isolated from shadow/apply governance.

## Benchmark

The **`procedural-recall`** benchmark in `@remnic/bench` scores:

1. **Task initiation gate** — deterministic intent classification vs. labeled prompts.
2. **Procedure section gate** — temp `memoryDir` round-trip: whether a non-null recall section is produced when expected (feature on/off and non-task prompts).

Run a quick pass:

```bash
npm run bench:run -- --quick procedural-recall
```
