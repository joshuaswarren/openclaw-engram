# Theory: Benchmark Discipline Becomes Real At The Required Check

## Problem

PR32 created durable baseline snapshots.
PR33 made those snapshots comparable against current candidate runs.

That still left one gap: the required PR gate was comparing two fixture stores
directly, not comparing a candidate branch against the named baseline snapshot
the repo had chosen to trust.

If that gap stayed open, Engram could claim benchmark-gated release discipline
without actually enforcing it at merge time.

## Operating Theory

PR34 should operationalize the stored-baseline model, not replace it.

The cleanest rollout is:

1. keep the existing required workflow and check name
2. read the named baseline snapshot from the base branch checkout
3. allow a one-time candidate fallback only when the base branch has not adopted
   the named baseline yet
4. compare the candidate branch fixture runs against that stored baseline
5. fail the PR when candidate artifacts are invalid or benchmark outcomes regress

This preserves the key distinction introduced in PR32 and PR33:

- the baseline is deliberate and named
- the candidate view is the latest completed run set
- the merge gate compares those two contracts directly

## Strategy

Keep the slice small and reviewable:

- add one stored-baseline CI helper
- point the existing `eval-benchmark-gate` workflow at it
- commit one explicit required baseline fixture snapshot:
  `tests/fixtures/eval-ci/store/baselines/required-main.json`
- document that snapshot as the PR-gating contract

The important constraint is continuity. The workflow name should stay stable so
branch protection does not change, while the comparison semantics underneath it
become stricter and more intentional.

## Key Discoveries

- PR34 does not need another public operator command. The missing piece is a CI
  path that reads a base-branch baseline snapshot while still evaluating the
  candidate branch run artifacts.
- Using a committed named snapshot is better than an implicit "latest from
  base" rule because it makes the release baseline auditable and reviewable in
  the repo.
- The rollout PR itself is a bootstrap edge case: `main` cannot provide the new
  required snapshot until the PR lands. That needs an explicit, visible
  candidate fallback rather than a silent failure or a one-off manual merge.
- The existing `EvalBaselineDeltaReport` contract from PR33 was already strong
  enough for rollout. The required check only needed a thin adapter that swaps
  the source of the baseline snapshot from "current store" to "base branch
  store."

## Remaining Question

- After PR34 lands, the roadmap program is functionally complete, but the next
  improvement path would be automating how the `required-main` fixture snapshot
  gets refreshed so baseline promotion is itself deliberate and benchmark-backed.
