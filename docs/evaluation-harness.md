# Evaluation Harness

Engram is moving to a benchmark-first development model. This first slice adds the storage contract and status tooling for an AMA-Bench-style evaluation harness without changing live recall behavior.

## Why This Exists

Recent agent-memory work is clear: memory should be evaluated on real agent trajectories, not chat QA. Engram's evaluation harness is meant to answer one operational question for every memory PR:

`Did this make agent outcomes better, worse, or just different?`

Primary source:
- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769

## Current Scope

This slice ships:

- `evalHarnessEnabled`
- `evalShadowModeEnabled`
- `evalStoreDir`
- `openclaw engram benchmark-status`
- `openclaw engram benchmark-validate <path>`
- `openclaw engram benchmark-import <path> [--force]`
- typed benchmark manifest validation
- typed run-summary validation
- typed shadow recall recording for live recall decisions

This slice does **not** yet ship:

- benchmark runners
- PR regression gates
- objective-state capture
- trust-zoned promotion logic

Those land in follow-on PR slices documented in the roadmap.

## Directory Layout

By default, Engram looks under:

```text
{memoryDir}/state/evals/
  benchmarks/
    <benchmark-id>/
      manifest.json
  runs/
    <run-id>.json
  shadow/
    YYYY-MM-DD/
      <trace-id>.json
```

You can override the root with `evalStoreDir`.

## Benchmark Manifest Format

```json
{
  "schemaVersion": 1,
  "benchmarkId": "ama-memory",
  "title": "AMA-style agent memory harness",
  "tags": ["trajectory", "objective-state"],
  "sourceLinks": ["https://arxiv.org/abs/2602.22769"],
  "cases": [
    {
      "id": "case-1",
      "prompt": "Resume the broken deployment and explain what changed.",
      "expectedSignals": ["objective-state", "causal-trajectory"]
    }
  ]
}
```

Required fields:

- `schemaVersion`
- `benchmarkId`
- `title`
- `cases[].id`
- `cases[].prompt`

## Run Summary Format

```json
{
  "schemaVersion": 1,
  "runId": "run-001",
  "benchmarkId": "ama-memory",
  "status": "completed",
  "startedAt": "2026-03-06T10:00:00.000Z",
  "completedAt": "2026-03-06T10:02:00.000Z",
  "totalCases": 12,
  "passedCases": 9,
  "failedCases": 3,
  "metrics": {
    "actionOutcomeScore": 0.81,
    "objectiveStateCoverage": 0.67
  }
}
```

Supported statuses:

- `running`
- `completed`
- `failed`
- `partial`

## Shadow Recall Record Format

When both `evalHarnessEnabled` and `evalShadowModeEnabled` are on, Engram records a best-effort shadow snapshot for each live recall decision without changing the injected context:

```json
{
  "schemaVersion": 1,
  "traceId": "3f3ec9f5b356c1f2",
  "recordedAt": "2026-03-06T10:03:00.000Z",
  "sessionKey": "agent:main",
  "promptHash": "abc123",
  "promptLength": 42,
  "retrievalQueryHash": "def456",
  "retrievalQueryLength": 42,
  "recallMode": "full",
  "recallResultLimit": 4,
  "source": "hot_qmd",
  "recalledMemoryCount": 2,
  "injected": true,
  "contextChars": 240,
  "memoryIds": ["mem-1", "mem-2"],
  "durationMs": 22
}
```

These records are intentionally compact:

- no raw prompt text
- no raw memory content
- enough metadata to measure live recall behavior and compare later benchmark slices

## CLI

```bash
openclaw engram benchmark-status
openclaw engram benchmark-validate ./benchmarks/ama-memory
openclaw engram benchmark-import ./benchmarks/ama-memory
```

The command reports:

- whether the harness is enabled
- whether shadow mode is enabled
- benchmark pack counts
- invalid benchmark manifests
- total case counts
- latest run summary
- shadow recall counts
- invalid shadow records
- latest shadow recall summary

The validation/import tools:

- accept either a manifest JSON file or a benchmark pack directory with a root `manifest.json`
- validate the manifest before import
- import packs into `benchmarks/<benchmarkId>/`
- preserve extra files when importing a directory pack
- require `--force` to replace an existing imported benchmark pack

## Rollout Guidance

- Keep `evalHarnessEnabled: false` by default in production until you want benchmark bookkeeping on disk.
- Turn on `evalShadowModeEnabled` when you want to start recording live recall decisions for measurement without changing recall output.
- Treat benchmark packs as versioned operator assets. PRs that change them should explain why the benchmark changed.

## Next Steps

See:

- [Agentic Memory Roadmap](plans/2026-03-06-engram-agentic-memory-roadmap.md)
- [PR1 Eval Harness Foundation Plan](plans/2026-03-06-engram-pr1-eval-harness-foundation.md)
- [PR2 Benchmark Pack Validator And Import Tools](plans/2026-03-06-engram-pr2-benchmark-tools.md)
- [PR3 Shadow Recording For Live Recall Decisions](plans/2026-03-07-engram-pr3-shadow-recording.md)
