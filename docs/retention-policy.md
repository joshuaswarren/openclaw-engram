# Retention policy

> Issue: [#686 — Year-2 retention: scaling decay, index pruning, and forgetting at scale](https://github.com/joshuaswarren/remnic/issues/686).
>
> This document is the operator's reference for Remnic's retention substrate.
> It describes the tier model, what the lifecycle policy does, what stays
> opt-in vs default-on, and how to inspect or intervene when a memory ends up
> in the wrong place.

## Why retention matters

Every long-running memory store hits the same wall: the index keeps growing
even though most of the value is in a small, recently-touched subset. Without
retention, the BM25 index, the graph, and the cold-scan fallback all compound
indefinitely; recall@K erodes because relevant recent facts compete with stale
chatter; cold-start probes get slower; backups balloon.

[agentmemory](https://github.com/rohitg00/agentmemory) explicitly calls year-2
retention an unsolved problem. Remnic's answer is a value-scored two-tier
substrate plus an explicit forget surface — described below.

## The tier model

Remnic stores memories in two **physical tiers** plus an archival escape hatch:

- **Hot tier** — `<memoryDir>/{facts,procedures,reasoning-traces,corrections}/`
  on disk; indexed in the QMD collection named by `qmdCollection` (default
  `openclaw-engram`). This is the default search path.
- **Cold tier** — `<memoryDir>/cold/...` on disk; indexed in the separate QMD
  collection named by `qmdColdCollection` (default `openclaw-engram-cold`).
  Searched only when `qmdColdTierEnabled === true` and the recall path opts
  into the cold-fallback pipeline.
- **Archive** — `<memoryDir>/archive/...`. Not part of either active tier;
  scanned only as a last-ditch fallback when both hot and cold yield no
  results.

`tier-routing.ts` and `tier-migration.ts` implement the migration logic, the
value-score model, and the journaling. The cold collection is a real,
separate QMD index — not a virtual partition — so demoting a memory removes
it from the live index size accounting.

### How a memory's tier is decided

`computeTierValueScore(memory, now, signals)` aggregates several signals into
a single `[0, 1]` value:

| Signal              | Weight | Meaning                                              |
|---------------------|-------:|------------------------------------------------------|
| `confidence`        | 0.24   | Caller-asserted confidence in the fact.              |
| `access`            | 0.26   | How often the memory has been accessed recently.     |
| `recency`           | 0.20   | How recently the memory was created or accessed.     |
| `importance`        | 0.20   | Calibrated importance score from extraction.         |
| `feedback`          | 0.10   | User-feedback signal.                                |
| correction-category | +0.08  | Bonus when category is `correction`.                 |
| user-confirmed      | +0.05  | Bonus when `verificationState === "user_confirmed"`. |
| disputed-fact       | −0.50  | Heavy penalty for disputed memories.                 |

`decideTierTransition(memory, currentTier, policy, now, signals)` then
applies the policy:

- **Hot → Cold (demotion)** when `ageDays >= demotionMinAgeDays` AND
  `valueScore <= demotionValueThreshold`.
- **Cold → Hot (promotion)** when `valueScore >= promotionValueThreshold`.
- Otherwise stays put.

## What ships on by default vs opt-in

| Behavior                                              | Status on current branch |
|-------------------------------------------------------|--------------------------|
| Lifecycle policy engine (`lifecyclePolicyEnabled`)    | default `false` (opt-in) |
| Lifecycle metrics (`lifecycleMetricsEnabled`)         | explicit value, otherwise mirrors policy |
| Tier migration (`qmdTierMigrationEnabled`)            | default `false` (opt-in) |
| Recall queries hot tier only                          | always (PR 1/6 audit) |
| Cold-tier fallback (`qmdColdTierEnabled`)             | default `false` (opt-in) |
| Recall-time stale filter (`lifecycleFilterStaleEnabled`) | default `false` (opt-in) |

Automatic hot/cold migration is gated by `qmdTierMigrationEnabled: true`.
`lifecyclePolicyEnabled` controls the separate lifecycle scoring and metadata
pass. Both default off, so fresh installs keep pre-#686 behavior until an
operator explicitly enables the relevant path.

## Default-recall behavior (audit, #686 PR 1/6)

The recall path on `main` was audited and pinned with regression tests in
[#693](https://github.com/joshuaswarren/remnic/pull/693):

1. **Default recall queries the hot QMD collection only.** Every primary
   call to `fetchQmdMemoryResultsWithArtifactTopUp` outside of
   `applyColdFallbackPipeline` omits the `collection` option, so the QMD
   client falls through to the hot collection. The namespace-aware
   `searchAcrossNamespaces` path does the same.
2. **The cold QMD collection is opt-in.** Queried only inside
   `applyColdFallbackPipeline` and only when `qmdColdTierEnabled === true`.
   Default `false` — a fresh install never reaches the cold-QMD branch.
3. **The cold *directory* is not read on recall.**
   `StorageManager.collectActiveMemoryPaths` scans only the hot subtrees.
4. **Archive is read only as a last-ditch fallback.**

Regression tests in `tests/retrieval-cold-tier-default-excluded.test.ts`
keep this contract enforced via runtime tripwires that hook
`qmd.search` / `qmd.hybridSearch`,
`fetchQmdMemoryResultsWithArtifactTopUp`, and
`searchLongTermArchiveFallback`. Static AST audits were intentionally
dropped because their completeness is unbounded (computed property names,
shadowed identifiers, etc.); the runtime boundary check is strictly stronger.

## Bench: aged-dataset retention harness (#686 PR 2/6)

[#698](https://github.com/joshuaswarren/remnic/pull/698) shipped
`@remnic/bench`'s `retention-aged-dataset` benchmark — a hermetic synthetic
corpus generator with Pareto-distributed query frequencies, configurable
age skew, and deterministic seeds. The harness measures `recall@K`, latency
proxy, and hot/cold tier shares for both the full-corpus baseline and the
hot-only configuration.

Run it via:

```bash
remnic bench run --quick retention-aged-dataset
```

The bench produces a structured report including `recall_at_5_delta` so
default-tuning iterations have an objective signal.

## The forgotten tier (#686 PR 4/6)

The planned forgotten tier is a soft-delete state that excludes a memory from
recall, browse, and entity attribution while keeping the file on disk for the
retention window so the act is reversible. A dedicated forget command is not
present on this branch yet.

The follow-up implementation should define frontmatter equivalent to:

```yaml
status: forgotten
forgottenAt: 2026-04-25T18:30:00.000Z
forgottenReason: stale preference, user retracted
```

Once the soft-delete surface lands, forgotten memories should flow through the
existing status-allow-list filters (memory-cache, access-service browse,
retrieval) so they don't appear in any default surface. A future maintenance
cron will hard-delete forgotten memories after a configurable retention window
(default 90 days).

## Operator visibility (#686 PR 5/6)

Current OpenClaw plugin CLI surfaces give operators a window into the tier
substrate without manually walking the filesystem:

```bash
# Migration telemetry and last-cycle summary
openclaw engram tier-status

# One bounded migration pass; dry-run by default
openclaw engram tier-migrate --dry-run --limit 50

# Explain the most recent recall snapshot
openclaw engram recall-explain --format json
```

`tier-status` reports cumulative migration counters plus the latest cycle
summary (`cycles`, `scanned`, `migrated`, `promoted`, `demoted`, `errors`).

`tier-migrate` runs one bounded maintenance pass. It defaults to dry-run; pass
`--write` to apply mutations after reviewing the reported plan.

`recall-explain` reports the most recent recall snapshot (or a session selected
with `--session`) and can emit either text or JSON.

## Cold QMD opt-in

To search the cold QMD collection before archive fallback on hot misses:

```yaml
# openclaw.json plugin config
qmdColdTierEnabled: true
```

When enabled, `applyColdFallbackPipeline` queries the cold QMD collection only
after the hot-tier search returns no results. If cold QMD is disabled or returns
no hits, archive scan fallback can still run. Default off because the long-tail
rarely contributes to a recall worth the latency.

## Configuration knobs

| Key                                       | Default                | Purpose                                       |
|-------------------------------------------|-----------------------:|-----------------------------------------------|
| `lifecyclePolicyEnabled`                  | `false`                | Enable lifecycle scoring.                     |
| `lifecyclePromoteHeatThreshold`           | `0.55`                 | Cold→hot promotion threshold.                 |
| `lifecycleStaleDecayThreshold`            | `0.65`                 | Used by the demotion gate.                    |
| `lifecycleArchiveDecayThreshold`          | `0.85`                 | Used by the archive gate.                     |
| `lifecycleProtectedCategories`            | (5 categories)         | Categories never demoted automatically.       |
| `lifecycleMetricsEnabled`                 | mirrors policy         | Emit lifecycle metrics for inspection.        |
| `lifecycleFilterStaleEnabled`             | `false`                | Filter stale lifecycle memories from recall.  |
| `qmdTierMigrationEnabled`                 | `false`                | Enable value-aware hot/cold tier migration.   |
| `qmdColdTierEnabled`                      | `false`                | Query cold QMD before archive fallback.       |
| `qmdColdCollection`                       | `openclaw-engram-cold` | QMD collection name for cold tier.            |

See `docs/config-reference.md` for the full schema.

## Auditing the substrate

Three signals together let an operator confirm the policy is doing the
right thing:

1. `openclaw engram tier-status` — are migration cycles running and moving the expected counts?
2. `openclaw engram tier-migrate --dry-run --limit 50` — what would the next bounded migration pass move?
3. `openclaw engram recall-explain --format json` — for a surprising recall,
   which snapshot and tier signals were recorded?

When the answer is "the policy is right but the threshold is wrong," tune the
`lifecycle*` and `qmdTier*` config knobs and re-run the aged-dataset bench to
verify. A dedicated forget/restore surface remains future work on this branch.

## PR roll-up

Issue #686's six PRs:

| PR  | Title                                                          | Status              |
|-----|----------------------------------------------------------------|---------------------|
| 1/6 | Recall-path audit + cold-tier exclusion test                   | Merged ([#693](https://github.com/joshuaswarren/remnic/pull/693)) |
| 2/6 | Aged-dataset retention bench harness                           | Merged ([#698](https://github.com/joshuaswarren/remnic/pull/698)) |
| 3/6 | Lifecycle policy default and migration gate follow-up          | [#707](https://github.com/joshuaswarren/remnic/pull/707) |
| 4/6 | Forgotten-tier soft-delete surface                             | [#708](https://github.com/joshuaswarren/remnic/pull/708) |
| 5/6 | Operator visibility CLI follow-up                              | [#709](https://github.com/joshuaswarren/remnic/pull/709) |
| 6/6 | This document                                                  | This PR             |

## What's next

| Future PR | Scope |
|-----------|-------|
| Forget / restore / purge surfaces | Operator-managed soft-delete plus maintenance hard-delete after the configurable window. |
| HTTP / MCP surfaces for tier telemetry and recall explanation | Today these are CLI-only. |
| Default-tuning study | Ship a tunable threshold profile based on aged-dataset bench results across multiple corpus shapes. |
