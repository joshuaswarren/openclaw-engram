# Operator Console

The operator console (`remnic console`) is a live engine-introspection
surface for Remnic. It shows the current state of the engine's
pipelines — buffer, extraction queue, dedup decisions, maintenance
ledger tail, QMD probe, and daemon health — as they happen. Distinct
from [Recall X-ray](xray.md) (which inspects retrieval), the console
inspects the engine itself.

Tracking issue: [#688](https://github.com/joshuaswarren/remnic/issues/688).

## Modes

| Mode | Flag | What it does |
|------|------|--------------|
| **Live TUI** (default) | `remnic console` | Interactive five-panel terminal UI that polls the engine every 2 seconds. Press `Ctrl-C` to exit. |
| **One-shot snapshot** | `remnic console --state-only` | Prints a single `ConsoleStateSnapshot` as pretty-printed JSON and exits. Useful for piping into `jq` or external monitoring. |
| **Record trace** | `remnic console --record-trace <path>` | Runs the live TUI **and** appends every refresh-cycle snapshot to `<path>` as JSONL (one frame per line). |
| **Replay trace** | `remnic console --trace <path> [--speed N]` | Replays a previously-recorded JSONL trace at the original cadence. `--speed 2` halves the inter-frame delay; `--speed 0.5` doubles it. EOF exits cleanly. |

## Trace recording

`--record-trace <path>` opens the file in append mode (parent
directory is created with `mkdir -p`) and writes one
`ConsoleStateSnapshot` per line, separated by `\n`. Each line is a
self-contained JSON object — you can `jq -c` over the file or stream
it into another tool.

A trace recorder failure (disk full, permission denied) **never**
crashes the live TUI. Errors are captured internally and surfaced via
the recorder's `getLastError()` accessor; the loop keeps painting.

```bash
# Record a trace while you reproduce a problem.
remnic console --record-trace ~/.remnic/traces/2026-04-26.jsonl

# Inspect a few frames manually.
head -3 ~/.remnic/traces/2026-04-26.jsonl | jq .

# Hand the file to another operator for asynchronous review.
```

## Trace replay

`--trace <path>` reads the JSONL file frame-by-frame and feeds each
snapshot into the same `renderFrame` function the live TUI uses.
Replay is fully sandboxed: no orchestrator instance is required, no
filesystem reads beyond the trace file itself.

The inter-frame delay is computed from the captured `capturedAt`
timestamps (so a trace originally captured at 2 Hz replays at 2 Hz),
divided by the `--speed` multiplier:

```bash
# Replay at original cadence.
remnic console --trace trace.jsonl

# Replay 4× faster.
remnic console --trace trace.jsonl --speed 4

# Replay slowly enough to step through visually.
remnic console --trace trace.jsonl --speed 0.25
```

Edge cases:

- **Malformed lines** (invalid JSON, `null` literal, array literal)
  are skipped. The replay summary reports `framesSkipped`.
- **Negative deltas** (timestamps that go backward) are clamped to
  zero — the next frame paints immediately.
- **Pathologically long gaps** (hour-long pauses in the captured
  trace) are capped at 60 seconds so a tester always sees forward
  progress.
- **`--speed Infinity`** is permitted and means "no delay" — frames
  paint back-to-back.

## On-disk trace format

Each line of a trace file is the full JSON-serialized
`ConsoleStateSnapshot` produced by
[`gatherConsoleState`](../packages/remnic-core/src/console/state.ts):

```json
{
  "capturedAt": "2026-04-26T15:23:01.512Z",
  "bufferState": { "turnsCount": 4, "byteCount": 312 },
  "extractionQueue": { "depth": 0, "recentVerdicts": [...] },
  "dedupRecent": [...],
  "maintenanceLedgerTail": [...],
  "qmdProbe": { "available": true, "daemonMode": true, "debug": "..." },
  "daemon": { "uptimeMs": 9421000, "version": "9.3.205" },
  "errors": []
}
```

The schema is intentionally identical to the `--state-only` and
`/console/state` HTTP responses, so the same trace file can be
post-processed with the same tooling.

## Source

| File | Role |
|------|------|
| `packages/remnic-core/src/console/state.ts` | Engine-state aggregator (PR 1/3, [#721](https://github.com/joshuaswarren/remnic/pull/721)). |
| `packages/remnic-core/src/console/tui.ts` | Live TUI render loop (PR 2/3, [#728](https://github.com/joshuaswarren/remnic/pull/728)). |
| `packages/remnic-core/src/console/trace.ts` | Trace record + replay (PR 3/3). |
