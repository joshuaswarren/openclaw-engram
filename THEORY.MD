# Theory: Poisoning Defense Needs Explicit Trust Signals Before Policy

## Problem

Trust zones now exist as storage, promotion, and retrieval surfaces, but they
still lack an explicit measure of provenance quality. Without that measure,
later poisoning-defense work would have to infer trust indirectly from ad hoc
conditions scattered across promotion rules and retrieval code.

That would make the defense track hard to test, hard to explain, and easy to
regress. The next step is therefore not full corroboration or adversarial
benchmarks yet. The next step is to make provenance trust legible.

## Operating Theory

The memory-OS roadmap continues to work because each new capability is arriving
in a strict order:

1. persist the new memory substrate
2. expose bounded operator controls
3. add a measured retrieval surface
4. add explicit defensive signals
5. only then automate policy

For the poisoning-defense track, PR14 is the defensive-signal step. The system
needs one deterministic trust score derived from what is already in the record:
source class, source identity, evidence anchor, and session anchor.

That score is useful even before it drives decisions because it turns "trust"
from a vague intention into a contract that tests, operators, and later PRs can
all see.

## Strategy

Keep the slice intentionally narrow:

- defaults-off behind a dedicated config flag
- compute the score from stored provenance only
- expose the score in trust-zone status, not in automatic promotion behavior
- leave corroboration and attack simulation for later slices

This preserves the roadmap discipline. PR14 should not try to solve poisoning
defense end to end. It should create the explicit signal that PR15 and PR16 can
build on.

## Key Discoveries

- Provenance trust should be deterministic for a stored record. If the score
  depends on wall-clock timing or query context, it becomes harder to benchmark
  and easier to dispute.
- The first score does not need model-based judgment. Source class plus explicit
  anchors (`sourceId`, `evidenceHash`, `sessionKey`) is enough to create a
  useful first trust floor.
- Trust scoring belongs in status output first. That keeps the operator surface
  inspectable and reviewable before any automated gating starts relying on it.

## Open Questions

- Should PR15 treat trust score as an advisory signal layered on top of
  corroboration, or as part of the promotion eligibility threshold itself?
- Should future retrieval slices use trust score only as a tie-breaker, or
  should low-trust records be filtered from some sections entirely?
- When PR16 adds red-team benchmarks, should those packs assert on raw trust
  breakdowns, aggregate bands, or downstream promotion/retrieval outcomes?
