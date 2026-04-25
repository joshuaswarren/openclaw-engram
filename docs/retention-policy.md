# Retention policy

This document describes Remnic's retention substrate and how the recall path
treats hot vs cold tiers. It will be expanded across issue #686 PRs (PR 6/6
rewrites it for the full year-2 retention story). This first version pins the
audit findings from PR 1/6.

## Tiers

Remnic stores memories in two physical tiers:

- **Hot tier** — `<memoryDir>/{facts,procedures,reasoning-traces,corrections}/`
  on disk; indexed in the QMD collection named by `qmdCollection` (default
  `openclaw-engram`).
- **Cold tier** — `<memoryDir>/cold/...` on disk; indexed in the separate
  QMD collection named by `qmdColdCollection` (default
  `openclaw-engram-cold`).

In addition, lifecycle archived memories live under `<memoryDir>/archive/...`
and are not part of either active tier; they are scanned only as a last-ditch
fallback when both hot and cold yield no results.

## Default-recall behavior (audit, issue #686 PR 1/6)

This is the verified behavior on `main` as of PR #686/1:

1. **Default recall queries the hot QMD collection only.** Every primary
   call to `fetchQmdMemoryResultsWithArtifactTopUp` outside of
   `applyColdFallbackPipeline` omits the `collection` option, so the QMD
   client falls through to the hot collection (`qmdCollection`). The
   namespace-aware `searchAcrossNamespaces` path does the same.

2. **The cold QMD collection is opt-in.** It is queried only inside
   `applyColdFallbackPipeline` and only when `qmdColdTierEnabled === true`.
   The default for `qmdColdTierEnabled` is `false` (`config.ts` line ~916),
   so a fresh install never reaches the cold-QMD branch.

3. **The cold *directory* (`<memoryDir>/cold/...`) is not read on recall.**
   `StorageManager.collectActiveMemoryPaths` scans only the hot subtrees
   (`facts/`, `procedures/`, `reasoning-traces/`, `corrections/`).
   `readAllColdMemories` is called only by `temporal-supersession.ts` at
   write-time, never by retrieval.

4. **The cold-fallback pipeline can still run with the cold tier disabled,
   but only as an archive scan.** When hot recall produces no results,
   `applyColdFallbackPipeline` is invoked. With `qmdColdTierEnabled: false`
   it skips the cold-QMD branch and falls through to
   `searchLongTermArchiveFallback`, which reads `archive/` (the lifecycle
   archive directory), not `cold/`. This branch is named `cold_fallback` in
   recall telemetry but does not touch the cold tier.

5. **Cold-fallback exits cleanly when nothing is configured and nothing is
   archived.** If both branches return empty, `applyColdFallbackPipeline`
   returns `[]` and the recall response surfaces with no long-term section.

### Regression tests pinning this behavior

`tests/retrieval-cold-tier-default-excluded.test.ts`:

- `parseConfig: qmdColdTierEnabled defaults to false (cold tier opt-in)`
- `applyColdFallbackPipeline: cold QMD collection NOT queried under default
  config`
- `applyColdFallbackPipeline: cold QMD IS queried when explicitly opted in`
- `primary recall path (fetchQmdMemoryResultsWithArtifactTopUp default
  invocation) does not target cold collection` — a static-call-site audit
  asserting that exactly one call site in `orchestrator.ts` passes
  `collection: coldCollection`, and every other call omits the `collection`
  option entirely.

If a future PR adds another caller that targets `qmdColdCollection`, the
fourth test will fail loudly so the audit can be re-run.

## Related configuration

| Config key | Default | Purpose |
| --- | --- | --- |
| `qmdColdTierEnabled` | `false` | Opt-in: query the cold QMD collection during cold-fallback. |
| `qmdColdCollection` | `openclaw-engram-cold` | Cold-tier QMD collection name. |
| `qmdColdMaxResults` | `8` | Cap on cold-tier results merged into the long-term section. |
| `qmdTierMigrationEnabled` | `false` | Hot↔cold migration executor. |
| `lifecyclePolicyEnabled` | `false` | Stale/archive decay scoring (#686 PR 3/6 will flip after bench validation). |

See `docs/config-reference.md` for the full schema.

## What changes in later PRs of #686

- **PR 2/6** — bench harness exercises this path against an aged dataset
  (1- and 2-year corpora) with `lifecyclePolicyEnabled` both off and on.
- **PR 3/6** — once the bench shows hot-only recall@K within 1pp of full
  corpus at 5–10× hot-index reduction, `lifecyclePolicyEnabled` defaults to
  `true`.
- **PR 4/6** — adds the `forgotten` tier (`remnic forget` / `remnic purge`).
- **PR 5/6** — operator visibility (`remnic doctor`, `remnic tier`).
- **PR 6/6** — rewrites this doc for the full retention story.
