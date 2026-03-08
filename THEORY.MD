# Theory: Utility Learning Must Stay Snapshot-Driven Even After Runtime Activation

## Problem

Engram now has the full utility-learning chain for this roadmap segment:
typed outcome telemetry, an offline learner snapshot, and the first bounded
runtime consumer. The problem is no longer how to capture or learn from utility
signals. The problem is how to let those learned signals improve live recall
and tier routing without turning the hot path into a second learner.

If runtime code starts re-reading raw telemetry or inventing new weighting math
on every request, the memory system becomes harder to reason about, harder to
benchmark, and easier to destabilize. PR31 matters because it is the point
where utility learning stops being an operator-only artifact and starts shaping
agent behavior.

## Operating Theory

The right runtime contract is still the same three-step memory-OS pattern:

1. capture evidence explicitly
2. learn from it offline into a bounded snapshot
3. let runtime consume only that bounded snapshot

That means the live system should not ask "what do recent utility events say?"
It should ask "what bounded snapshot did the learner already publish?"

For PR31, the bounded consumer surface is intentionally narrow:

- ranking uses learned `boost` and `suppress` multipliers only on heuristic
  deltas that already exist in `boostSearchResults`
- tier migration uses learned `promote` and `demote` weights only as small
  threshold nudges on the existing hot/cold routing policy
- both behaviors remain behind the existing dual gate of
  `memoryUtilityLearningEnabled` and `promotionByOutcomeEnabled`

## Strategy

The strategy is to keep runtime activation smaller than the learner itself.
Rather than introduce a new runtime policy file or new flags, Engram loads the
existing learner snapshot and clamps it into a dedicated runtime view:

- bounded ranking multipliers
- bounded promotion threshold delta
- bounded demotion threshold delta

Those values are then applied only at two seams that already exist:

- heuristic score deltas inside `boostSearchResults`
- threshold construction inside `runTierMigrationCycle`

This keeps PR31 aligned with the rest of the roadmap: small slices, fail-open
behavior, and explicit benchmarkable contracts.

## Key Discoveries

- The runtime gate is not just `memoryUtilityLearningEnabled`. The second flag,
  `promotionByOutcomeEnabled`, is the real behavior-change switch for this
  slice, so runtime loading should stay disabled unless both flags are on.
- Ranking application is safest when it scales existing heuristic deltas rather
  than the base lexical score. That lets utility learning tune the heuristic
  layer without hiding the underlying retrieval signal.
- Tier-migration application does not need a second learner. A bounded wrapper
  around the existing `TierRoutingPolicy` is enough for the first runtime slice.
- The unstable part of this work was not the runtime math; it was an
  over-specific cold-tier integration fixture. The durable contract is better
  expressed with pure runtime-policy tests plus a focused `boostSearchResults`
  integration test.

## Open Questions

- Should later slices reload the utility snapshot during long-lived runtime
  processes, or is process-start loading enough until benchmark evidence says
  otherwise?
- Should future ranking slices split utility multipliers by heuristic class
  instead of using one bounded `boost` multiplier and one bounded `suppress`
  multiplier?
- When benchmark packs evolve, should utility-learning regressions be checked
  directly in the CI gate rather than only through broader recall outcomes?
