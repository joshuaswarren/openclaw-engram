# Theory: Utility Learning Needs a Stable Outcome Ledger Before It Can Tune Memory

## Problem

Engram now has benchmark infrastructure, objective-state memory, trust zones,
harmonic retrieval, creation memory, and bounded resume bundles. What it still
lacks is a stable way to connect those memory decisions to downstream utility.

Without that contract, later slices would have to infer utility from whatever
telemetry happened to exist at the time, which would make promotion-by-outcome
fragile, inconsistent, and hard to benchmark. PR29 exists to prevent that
drift by freezing the first explicit utility-learning schema before any learner
or runtime weighting logic appears.

## Operating Theory

Utility learning should begin as explicit evidence, not implicit inference.
The first requirement is a typed ledger that can answer:

- what memory surface was being adjusted (`promotion` or `ranking`)
- what action was taken (`promote`, `hold`, `boost`, `suppress`, etc.)
- what downstream outcome was observed (`helpful`, `neutral`, `harmful`)
- how strong that signal was (`utilityScore` in a bounded range)

That contract needs to be durable, date-partitioned, and operator-visible.
Only then can later slices safely learn weights offline and apply them at
runtime without rewriting storage semantics or re-litigating telemetry shape.

## Strategy

Keep PR29 as a contract slice:

1. add the roadmap flags `memoryUtilityLearningEnabled` and
   `promotionByOutcomeEnabled`
2. persist typed utility events under a dedicated `state/utility-telemetry`
   store
3. expose status and explicit recording commands so benchmarks and operators
   can write first-class outcome evidence
4. make disabled mode a true no-op so feature rollout stays bounded

This mirrors the rest of the roadmap: store first, learner second, runtime
policy last.

## Key Discoveries

- The repo already has telemetry idioms for action outcomes and status tools,
  so PR29 does not need a novel storage pattern; it only needs a domain-specific
  utility contract.
- `promotionByOutcomeEnabled` should exist in config now even though it does
  not change runtime behavior yet. That keeps the rollout honest: PR29 is the
  schema, PR30 is the learner, PR31 is bounded application.
- The same disabled-mode lesson from PR27 applies here. A feature flag is only
  real when the CLI/status path short-circuits before scanning storage.

## Open Questions

- Should PR30 learn one shared weight model across both `promotion` and
  `ranking`, or derive separate weight families per target?
- When benchmark packs record utility events, should they point directly to
  memory ids only, or also to recall-section ids and evaluation case ids?
- What is the right decay model for stale utility signals once runtime
  application lands?
