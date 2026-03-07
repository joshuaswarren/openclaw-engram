# Theory: Poisoning Defense Needs Typed Attack Suites, Not Just Policy

## Problem

Engram now has real trust tiers, explicit promotion rules, bounded trust-zone
recall, deterministic provenance trust scoring, and corroboration rules for
risky promotions. That closes one policy gap, but it still leaves a measurement
gap: poisoning-defense regressions can still hide inside generic benchmark packs
with no explicit attack identity.

If attack suites are not typed, operators and reviewers cannot tell whether the
eval harness is actually covering provenance spoofing, subagent contamination,
or trust-zone promotion failures. The defense exists, but the benchmark surface
stays too implicit to police over time.

## Operating Theory

The trust-zone rollout is working because it has stayed ordered:

1. store trust tiers
2. define promotion boundaries
3. expose bounded recall
4. surface deterministic trust signals
5. require independent corroboration for risky promotions
6. make attack suites first-class benchmark assets
7. only then benchmark attacks at scale and tune policy

PR14 completed step 4. PR15 completed step 5. PR16 is step 6: teach the eval
harness to recognize poisoning-defense suites explicitly through typed
`memory-red-team` benchmark manifests.

That keeps the benchmark layer explainable. A defense suite is no longer just a
tagged benchmark pack. It becomes an explicit attack surface with a known class
and target.

## Strategy

Keep the attack-pack contract narrow and deterministic:

- preserve backward compatibility for existing standard benchmark packs
- add one explicit new benchmark type: `memory-red-team`
- require `attackClass` and `targetSurface`
- surface those fields in validation, import, and status output
- avoid adding runner orchestration or replay logic yet

This preserves small-slice discipline. PR16 is not a full red-team runner. It
is the smallest bounded benchmark-surface change that makes poisoning-defense
coverage visible and enforceable in review.

## Key Discoveries

- Poisoning-defense benchmarks need explicit attack identity, not just tags.
  Tags are useful filters, but they are too weak to serve as the contract for
  a regression suite the team wants to protect in CI and review.
- Benchmark typing should stay smaller than runner typing. The harness can
  become attack-aware before it becomes attack-executing.
- The first typed attack metadata should live at the manifest level. That is
  enough to classify and count suites before deciding whether case-level attack
  annotations are worth the complexity.
- Benchmark visibility belongs before attack automation. The system should first
  know what attack coverage exists before it tries to scale execution.

## Open Questions

- Should later red-team slices attach attack metadata per case as well as per
  manifest, or is pack-level classification enough for the first generation?
- Should future CI gates require minimum red-team coverage by `attackClass` and
  `targetSurface`, or stay at pass/fail deltas only?
- When replay execution lands, should `memory-red-team` packs run through the
  same runner contracts as standard packs or a distinct adversarial path?
