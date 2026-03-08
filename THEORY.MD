# Theory: Benchmark Gates Need Named Baselines, Not Just Store Comparisons

## Problem

Engram already has the core pieces of a benchmark-first memory system:
benchmark-pack validation, run summaries, shadow recall recording, and a
candidate-vs-base store comparator. That is enough to prove that memory changes
can be measured, but it is not yet enough to make that measurement durable.

The missing piece is a named baseline artifact. Without one, later PR
comparison still depends on whichever branch or eval-store directory happens to
be available at review time. That makes the release discipline weaker than the
rest of the roadmap: reproducible in principle, but still too dependent on
operator state.

## Operating Theory

The evaluation harness should follow the same pattern as the rest of Engram's
memory operating system:

1. define a typed artifact
2. store it under the normal state root
3. expose it with operator-facing tooling
4. let later slices consume that artifact instead of re-inventing the contract

For benchmark release discipline, the typed artifact is a baseline snapshot of
the latest completed run per benchmark. The snapshot should be small and
durable: benchmark ids, run ids, pass rates, shared metrics, source root, and
optional notes. It should not duplicate benchmark cases or raw prompt content.

## Strategy

PR32 stays deliberately narrow.

It adds:

- a new `benchmarkBaselineSnapshotsEnabled` flag
- typed `EvalBaselineSnapshot` validation
- storage under `state/evals/baselines`
- a CLI command to capture a named baseline snapshot
- status visibility through the existing `benchmark-status` command

It does not yet add PR delta reporting or required CI rollout. Those belong to
PR33 and PR34. The goal here is to create the stable artifact that those later
slices will consume.

## Key Discoveries

- The right substrate already existed in PR4. `latestCompletedRunsByBenchmark`
  is the exact bounded view needed for a baseline snapshot, so PR32 does not
  need to invent another aggregation layer.
- Baseline snapshots are best treated as eval-store artifacts, not repo-root
  metadata. Keeping them under `state/evals` makes them align with manifests,
  runs, and shadows, and keeps the storage model coherent.
- `benchmark-status` is the right operator surface for this slice. A separate
  baseline-status command would add another status surface before the baseline
  artifact has any downstream consumers.
- The baseline snapshot should fail closed when disabled. This keeps the slice
  behind its own feature flag while still allowing the broader evaluation
  harness to remain enabled independently.

## Open Questions

- Should PR33 compare candidates directly to a named baseline snapshot, or
  resolve a snapshot into a temporary synthetic store and reuse the existing
  CI-gate machinery?
- Should baseline snapshots later include selected benchmark metadata such as
  tags or source links for richer human reporting, or should they stay limited
  to run-level outcome data?
- Once PR34 lands, should the project maintain one rolling baseline snapshot or
  a sequence of named snapshots tied to release points?
