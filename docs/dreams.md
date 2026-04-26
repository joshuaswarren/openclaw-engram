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
- `summaryRecallHours`, `summaryModel` — summary snapshot horizon
  and model used during REM.

### Deep sleep gates (today)

- The `fileHygiene` block (`fileHygiene.enabled`,
  `fileHygiene.archiveDir`, `fileHygiene.lintBudgetBytes`,
  `fileHygiene.rotateEnabled`, `fileHygiene.rotateMaxBytes`,
  `fileHygiene.warningsLogPath`, etc.) — drives archive and warning
  emission for files that exceed size thresholds.
- `versioningMaxPerPage` (top-level config key, consumed by
  `page-versioning.ts` as `maxVersionsPerPage`) — retention for the
  snapshot history that every memory file overwrite produces. `0`
  disables pruning.
- The `engram-nightly-governance` cron registered in
  `maintenance/memory-governance-cron.ts` — orchestrates the deep
  sleep pass on a schedule. The same module also registers
  `engram-day-summary`, `engram-procedural-mining`, and
  `engram-contradiction-scan`. Light sleep and REM tasks are
  scheduled in adjacent crons today; PR 3/4 wires per-phase
  telemetry through the same registration path.

## What's next

This is PR 1/4. The remaining PRs in [issue
#678](https://github.com/joshuaswarren/remnic/issues/678) build on
this naming:

- **PR 2/4** — Group the existing per-cron / per-module thresholds
  into a `dreams.phases.{lightSleep,rem,deepSleep}.*` config block.
  Backward-compatible: the existing top-level keys still parse;
  any new key under `dreams.phases.*` wins when set. `remnic
  doctor` gains a section that lists current per-phase threshold
  values and the last-run timestamp for each phase.
- **PR 3/4** — Per-phase telemetry. Every event written to the
  maintenance ledger gains a `phase` field. New `remnic dreams
  status` CLI / `GET /dreams/status` HTTP / `engram.dreams_status`
  MCP surface returns the last 24h summary per phase.
- **PR 4/4** — Manual phase invocation. `remnic dreams run --phase
  light-sleep|rem|deep-sleep [--dry-run]` returns the same
  telemetry shape as a scheduled run, so debugging a misbehaving
  phase no longer requires waiting for the cron.

## See also

- [Memory Lifecycle](architecture/memory-lifecycle.md) — the canonical
  write → consolidation → expiry walkthrough that dreams sits inside.
- [Retention Policy](retention-policy.md) — value-score model, hot /
  cold tier substrate, and the `remnic forget` / `remnic tier list /
  explain` surfaces that share infrastructure with deep sleep.
- [Operations](operations.md) — backup, export, and CLI surfaces that
  consume the same observation ledger as dreams.
- Source-of-truth issue: [#678](https://github.com/joshuaswarren/remnic/issues/678).
