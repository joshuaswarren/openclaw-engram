# Theory: Stored Baselines Only Matter If PRs Can Read Them

## Problem

PR32 gave Engram a durable baseline artifact, but that alone does not create
benchmark-gated release discipline. A stored snapshot is useful only if the
next PR slice can consume it directly and turn it into an explicit pass/fail
signal for a candidate build.

Without that, the evaluation harness still depends on ad hoc store-to-store
comparisons and operator choreography. The baseline exists, but the review loop
still cannot ask the simple question it needs to ask: how does this candidate
compare to the named benchmark baseline we decided to trust?

## Operating Theory

PR33 should not invent a second evaluation system. The right move is to reuse
the same bounded comparison primitives that already power the CI gate:

- latest completed run per benchmark
- pass-rate deltas
- shared metric deltas
- fail-closed handling for invalid candidate artifacts

The new work is not another comparison engine. It is a bridge between two
existing contracts:

1. the stored `EvalBaselineSnapshot` artifact from PR32
2. the candidate latest-run view already used by PR4's CI gate

If that bridge is typed, operator-facing, and feature-flagged, then PR34 can
wire it into required CI without changing the report contract again.

## Strategy

Keep PR33 narrow and reviewable:

- add one flag: `benchmarkDeltaReporterEnabled`
- add one typed report: `EvalBaselineDeltaReport`
- add one CLI command: `openclaw engram benchmark-baseline-report --snapshot-id <id>`
- emit both JSON and markdown from the same source of truth

The command should compare a named stored baseline snapshot against the current
eval store, not against another branch directory. That preserves the point of
the baseline artifact: deliberate, reusable release anchors instead of transient
workspace state.

## Key Discoveries

- The existing CI-gate comparison path already has the right semantics for
  regressions and improvements. PR33 only needs to swap the base side from
  "latest runs in another store" to "benchmarks recorded in one named snapshot."
- Because the baseline snapshot lives in the same eval store as later candidate
  runs, a benchmark is only truly "missing" if its latest candidate run is no
  longer present after the snapshot is taken. That storage-model nuance needed a
  regression test so the report does not silently overstate coverage.
- Markdown output belongs in the report contract itself, not in a separate
  formatter script, because PR comments and release notes will want the same
  operator-facing summary that the CLI prints locally.

## Open Questions

- PR34 still needs to decide whether required CI should compare against one
  explicit snapshot id or a repo-level default baseline pointer.
- The baseline delta report currently treats invalid candidate baseline files as
  regressions too. That is conservative and useful today, but later slices may
  want a clearer distinction between "comparison baseline is unreadable" and
  "candidate benchmark behavior regressed."
- If Engram later supports multiple benchmark families with different rollout
  cadences, the project may need scoped baselines instead of one flat snapshot
  namespace.
