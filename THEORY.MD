# Theory: Utility Learning Should Happen Offline Before It Touches Live Ranking

## Problem

Engram now has the PR29 outcome ledger for utility telemetry. What it still
lacks is a stable offline learner that can turn those raw events into a
bounded artifact the runtime can consume later without re-reading or
reinterpreting the full telemetry store on every request.

Jumping straight from raw utility events to live ranking changes would make the
rollout brittle: the runtime would have to own grouping rules, weighting math,
sample thresholds, and decay semantics all at once. PR30 exists to separate
that concern. The learner should read the PR29 ledger offline, emit a typed and
bounded weight snapshot, and leave live application to PR31.

## Operating Theory

Utility learning should stay in the same rollout order as the rest of the
roadmap:

1. capture evidence explicitly
2. learn from it offline into a bounded snapshot
3. let the runtime consume only that bounded snapshot

For PR30, that means:

- group by the real policy surface: `target + decision`
- exclude low-sample groups instead of inventing weights from anecdotes
- compute bounded learned weights from average utility and confidence
- persist one typed snapshot so later slices can inspect or consume it
- keep all of this behind `memoryUtilityLearningEnabled`

## Strategy

Keep PR30 as an offline learner slice:

1. read utility telemetry from the PR29 event ledger
2. learn bounded weights per `target + decision`
3. persist a stable learner snapshot under `state/utility-telemetry`
4. expose operator-facing `utility-learn` and `utility-learning-status`
5. keep disabled mode a true no-op

This mirrors the rest of the roadmap: store first, learner second, runtime
policy last.

## Key Discoveries

- The repo already has two strong patterns to reuse here: `behavior-learner.ts`
  for bounded offline adjustment math and `policy-runtime.ts` for a persisted
  typed snapshot contract.
- The learner artifact should be its own file under the utility-telemetry root,
  not a runtime policy file. PR30 should not imply that weights are already
  applied.
- The same disabled-mode lesson from PR27 and PR29 applies here. A feature flag
  is only real when the CLI/status path short-circuits before scanning storage.
- Confidence needs to be derived from both utility magnitude and event count so
  small but noisy groups do not produce outsized weights.

## Open Questions

- How aggressively should PR31 apply the learned weights once runtime
  consumption lands?
- Should later slices add recency decay inside the learner snapshot itself, or
  keep decay implicit by recomputing over a bounded lookback window?
- When benchmark packs record utility events, should they eventually link to
  recall-section ids and evaluation case ids in addition to memory ids?
