# Dreams: named, phased consolidation

> **Status:** documentation only (PR 1/4 of [issue
> #678](https://github.com/joshuaswarren/remnic/issues/678)). This page
> describes the conceptual model and maps the existing implementation.
> No new code, config, CLI, or telemetry surface ships in this PR.
> Subsequent PRs add the `dreams.phases.*` config block (PR 2), the
> per-phase telemetry surface (PR 3), and the `remnic dreams run` CLI
> (PR 4).

## What "dreams" means here

In Remnic, **dreams** is the umbrella name for the background
consolidation pipeline that runs between user-facing turns: scoring
recent activity, synthesising and de-duplicating across sessions,
promoting durable findings, and migrating cold material out of the hot
working set.

The pipeline is split into three named phases that mirror the
biological metaphor:

1. **Light sleep** — recent activity scoring + clustering.
2. **REM** — cross-session synthesis, supersession resolution, and
   semantic consolidation.
3. **Deep sleep** — promotion to durable memory, hot→cold tier
   migration, page-version snapshots, and archive.

Every phase is implemented today by code that already ships on `main`.
This PR only renames and groups the existing primitives so operators
have one mental model and one vocabulary; the phase boundaries are
descriptive, not new behaviour.

## Naming note: three "dreams" concepts in the codebase

Remnic already uses the word "dreams" for two adjacent things. To
avoid confusion, this section catalogues all three usages explicitly.
The unqualified name **"dreams"** in this document — and in the future
`dreams.phases.*` config block, `remnic dreams` CLI, and
`engram.dreams_status` MCP tool — refers exclusively to the
consolidation pipeline.

| Concept | Where it lives today | What it is |
|---|---|---|
| **Dreams (this document)** — consolidation pipeline | `packages/remnic-core/src/maintenance/`, `semantic-consolidation.ts`, `tier-routing.ts`, `tier-migration.ts`, `temporal-supersession.ts`, `summarizer.ts`, `summary-snapshot.ts`, `page-versioning.ts`, `hygiene.ts`, `lifecycle.ts` | The phased background process described here. |
| **Dreams diary surface** | `packages/remnic-core/src/surfaces/dreams.ts` | Markdown-fragment surface that parses `<!-- openclaw:dreaming:diary:start -->` / `<!-- openclaw:dreaming:diary:end -->` markers in MEMORY-style files. Exposes `read` / `append` / `watch`. Unrelated to consolidation phases. |
| **`memoryKind: "dream"` frontmatter** | YAML frontmatter on memory files; recognised in `orchestrator.ts` and storage paths | A memory category. A single-fact tag, not a process. |

### Decision recorded by this PR

The pipeline gets the unqualified name **dreams**. The diary surface
and `memoryKind: "dream"` are pre-existing usages and stay as they
are for now. A follow-up may rename the diary surface to
`dream-diary` and revisit the `memoryKind` value to remove the
overlap, but that rename is explicitly out of scope for issues #678
PR 1–4. Until then, when reading code, treat the directory
`packages/remnic-core/src/surfaces/dreams.ts` as the diary, and
treat anything under `maintenance/` plus the consolidation modules
listed above as the pipeline.

## Phase mapping

The following table maps each named phase to the existing modules
that implement it today. Operators can already tune most of this
behaviour through the per-module config keys listed in the next
section; PR 2/4 will introduce the unified `dreams.phases.*` block
that reads those existing keys and lets the new keys win when set.

| Phase | What runs | Existing modules |
|---|---|---|
| **light sleep** | Recent activity scoring and clustering — assigns a value score to each candidate memory based on hits, recency, and lifecycle signals; emits an observation-ledger entry; updates the recent buffer state. | `tier-routing.ts` (`computeTierValueScore`, `decideTierTransition`), `lifecycle.ts` (heat / decay thresholds), `maintenance/observation-ledger-utils.ts`, `maintenance/rebuild-observations.ts`, buffer state in `buffer.ts`. |
| **REM** | Cross-session synthesis: cluster similar facts, resolve supersessions where a newer fact replaces an older one, and run semantic consolidation (SPLIT / MERGE / UPDATE) over the clusters. Emits summary snapshots. | `semantic-consolidation.ts` (`findSimilarClusters`, `buildConsolidationPrompt`, `chooseConsolidationOperator`, `parseOperatorAwareConsolidationResponse`), `temporal-supersession.ts` (`computeSupersessionKey`, `shouldSupersedeExisting`), `summarizer.ts`, `summary-snapshot.ts`, `consolidation-operator.ts`, `consolidation-provenance-check.ts`. |
| **deep sleep** | Promotion to durable memory, hot→cold tier migration, page-version snapshotting on every overwrite, and archive of stale or low-value entries. | `tier-migration.ts` (`migrateMemory`, hot↔cold journal), `page-versioning.ts` (snapshot/prune by `maxVersionsPerPage`), `hygiene.ts` (file size / archive triggers), `maintenance/archive-observations.ts`, `maintenance/memory-governance.ts`, `maintenance/memory-governance-cron.ts` (the `engram-nightly-governance` cron that orchestrates the deep-sleep run today). |

## Existing config gates per phase

These are the config keys that already exist in `config.ts` and
gate behaviour for each phase. PR 2/4 will group these under
`dreams.phases.{lightSleep,rem,deepSleep}.*` while keeping the
existing top-level keys readable for backward compatibility.

### Light sleep gates (today)

- `lifecyclePolicyEnabled` — master switch for value-score driven
  routing. Default `true`.
- `lifecycleFilterStaleEnabled` — filter stale entries out of recall.
  Default `false`.
- `lifecyclePromoteHeatThreshold` — value score above which a memory
  is treated as hot.
- `lifecycleStaleDecayThreshold` — value score below which a memory
  starts to decay.
- `lifecycleArchiveDecayThreshold` — value score below which a memory
  is eligible for archive.
- `lifecycleProtectedCategories` — categories that bypass decay /
  archive even when their score drops.

### REM gates (today)

- `temporalSupersessionEnabled` — supersession resolution at write /
  consolidation time. Default `true`.
- `temporalSupersessionIncludeInRecall` — whether superseded memories
  surface in recall. Default `false`.
- `semanticConsolidationEnabled` — turn on the cluster→merge /
  split / update LLM consolidator.
- `semanticConsolidationModel` — model used for the consolidation
  call. Falls back to the platform default.
- `semanticConsolidationThreshold` — cosine-similarity threshold for
  cluster membership. Default `0.8`.
- `semanticConsolidationMinClusterSize` — minimum cluster size before
  consolidation runs. Default `2` (clamped lower bound).
- `semanticConsolidationExcludeCategories` — categories that REM
  skips entirely.
- `semanticConsolidationIntervalHours` — how often the REM pass
  runs.
- `semanticConsolidationMaxPerRun` — cap on cluster operations per
  run, to bound cost.
- `consolidationMinIntervalMs` — global minimum gap between
  consolidation passes (default ~10 minutes).
- `consolidationRequireNonZeroExtraction` — only consolidate when
  the recent extraction has produced at least one fact. Default
  `true`.

(Note: `summaryRecallHours` and `summaryModel` are *not* REM-phase
gates — they configure the recall summaries path in
`orchestrator.ts`, not `runSemanticConsolidation`. Summary
snapshots themselves are written from a separate flow:
`HourlySummarizer.saveSummary` / `runHourly` in `summarizer.ts`
calls `summary-snapshot.ts`. That flow is *not* gated by the
`semanticConsolidation*` keys; do not expect tuning REM settings
to change snapshot behaviour.)

### Deep sleep gates (today)

- The `fileHygiene` block (`fileHygiene.enabled`,
  `fileHygiene.archiveDir`, `fileHygiene.lintBudgetBytes`,
  `fileHygiene.rotateEnabled`, `fileHygiene.rotateMaxBytes`,
  `fileHygiene.warningsLogPath`, etc.) — drives archive and warning
  emission for files that exceed size thresholds.
- `versioningEnabled` (default `false`) — master switch for
  page-version snapshots. `StorageManager.snapshotBeforeWrite`
  exits early when this flag is not set, so deep-sleep
  snapshotting is a no-op without it. Operators must enable this
  *before* tuning the retention key below.
- `versioningMaxPerPage` (top-level config key, consumed by
  `page-versioning.ts` as `maxVersionsPerPage`) — retention for the
  snapshot history that every memory file overwrite produces once
  `versioningEnabled` is `true`. `0` disables pruning.
- The `engram-nightly-governance` cron registered in
  `maintenance/memory-governance-cron.ts` — orchestrates the deep
  sleep pass on a schedule. The same module registers exactly four
  crons today: `engram-day-summary`, `engram-nightly-governance`,
  `engram-procedural-mining`, and `engram-contradiction-scan`.
  Light sleep and REM are *not* cron-scheduled — they run inside the
  orchestrator maintenance pass via `runLifecyclePolicyPass` (light
  sleep) and `runSemanticConsolidation` (REM) in `orchestrator.ts`.
  PR 3/4 (this PR) wires per-phase telemetry through both code paths
  (cron and orchestrator pass) so the named-phase view stays
  consistent regardless of which trigger ran the work.

## Per-phase telemetry (PR 3/4)

Every phase run — whether triggered by a cron, the orchestrator
maintenance pass, or the `remnic dreams run` CLI — appends one JSONL
entry to `<memoryDir>/state/dreams-ledger.jsonl`. The entry has this
shape:

```jsonc
{
  "schemaVersion": 1,
  "startedAt":     "2026-04-27T02:00:00.000Z",   // ISO-8601
  "completedAt":   "2026-04-27T02:00:05.123Z",
  "durationMs":    5123,
  "phase":         "lightSleep",                  // "lightSleep" | "rem" | "deepSleep"
  "itemsProcessed": 42,
  "dryRun":        false,
  "trigger":       "scheduled",                   // "scheduled" | "manual"
  "notes":         "scored 42 recent observation entries"
}
```

Older ledger entries that predate this PR simply won't have this
field. No backfill is required — the aggregator treats missing entries
as having zero runs.

### `remnic dreams status`

```
remnic dreams status [--window-hours <n>] [--format text|json|markdown]
```

Reads the dreams ledger and prints a per-phase summary for the last N
hours (default 24). Example text output:

```
Dreams status (last 24h):
  Window: 2026-04-26T12:00:00.000Z → 2026-04-27T12:00:00.000Z

  Light Sleep:
    Runs:            3
    Total duration:  4521ms
    Items processed: 127
    Last run:        2026-04-27T09:15:00.000Z

  REM:
    Runs:            1
    Total duration:  12450ms
    Items processed: 94
    Last run:        2026-04-27T03:00:00.000Z

  Deep Sleep:
    Runs:            1
    Total duration:  32100ms
    Items processed: 500
    Last run:        2026-04-27T02:23:00.000Z
```

### `GET /engram/v1/dreams/status`

```
GET /engram/v1/dreams/status?windowHours=24
```

Returns the same shape as a JSON body:

```jsonc
{
  "windowStart": "2026-04-26T12:00:00.000Z",
  "windowEnd":   "2026-04-27T12:00:00.000Z",
  "phases": {
    "lightSleep": {
      "phase": "lightSleep",
      "runCount": 3,
      "totalDurationMs": 4521,
      "totalItemsProcessed": 127,
      "lastRunAt": "2026-04-27T09:15:00.000Z",
      "lastDurationMs": 1200
    },
    "rem": { ... },
    "deepSleep": { ... }
  }
}
```

### MCP tool `engram.dreams_status` / `remnic.dreams_status`

```jsonc
// call
{ "name": "engram.dreams_status", "arguments": { "windowHours": 24 } }

// result — same shape as the HTTP response body
{ "windowStart": "...", "windowEnd": "...", "phases": { ... } }
```

## Manual phase invocation (PR 4/4)

`remnic dreams run` lets operators trigger a single phase without
waiting for the cron. This is useful for debugging a misbehaving
phase or for verifying that a configuration change has the expected
effect.

### `remnic dreams run`

```
remnic dreams run --phase <phase> [--dry-run] [--format text|json]
```

`--phase` accepts kebab-case (`light-sleep`, `rem`, `deep-sleep`) or
camelCase (`lightSleep`, `rem`, `deepSleep`).

`--dry-run` reports what would happen without committing any writes.
The ledger entry is not written in dry-run mode so the status surface
stays clean.

Example:

```
$ remnic dreams run --phase light-sleep --dry-run
Dreams run: Light Sleep (dry-run)
  Duration:   12ms
  Items:      84
  Notes:      dry-run: would score 84 observation entries
```

### `POST /engram/v1/dreams/run`

```jsonc
// request
POST /engram/v1/dreams/run
{ "phase": "lightSleep", "dryRun": true }

// response — same shape as a scheduled-run telemetry record
{
  "phase": "lightSleep",
  "dryRun": true,
  "durationMs": 12,
  "itemsProcessed": 84,
  "notes": "dry-run: would score 84 observation entries"
}
```

### MCP tool `engram.dreams_run` / `remnic.dreams_run`

```jsonc
// call
{ "name": "engram.dreams_run", "arguments": { "phase": "deepSleep", "dryRun": false } }

// result
{ "phase": "deepSleep", "dryRun": false, "durationMs": 31200, "itemsProcessed": 500 }
```

## What's next

PRs 3/4 and 4/4 are now shipped (combined in a single PR). The
remaining item from the original plan:

- **PR 2/4** (not yet shipped) — Group the existing per-cron /
  per-module thresholds into a `dreams.phases.{lightSleep,rem,deepSleep}.*`
  config block. Backward-compatible: the existing top-level keys still
  parse; any new key under `dreams.phases.*` wins when set. `remnic
  doctor` gains a section that lists current per-phase threshold values
  and the last-run timestamp for each phase.

## See also

- [Memory Lifecycle](architecture/memory-lifecycle.md) — the canonical
  write → consolidation → expiry walkthrough that dreams sits inside.
- [Retention Policy](retention-policy.md) — value-score model, hot /
  cold tier substrate, and the `remnic forget` / `remnic tier list /
  explain` surfaces that share infrastructure with deep sleep.
- [Operations](operations.md) — backup, export, and CLI surfaces that
  consume the same observation ledger as dreams.
- Source-of-truth issue: [#678](https://github.com/joshuaswarren/remnic/issues/678).
