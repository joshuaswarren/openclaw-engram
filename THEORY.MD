# Theory: Trust-Zone Retrieval Should Surface High-Trust Context Without Leaking Quarantine Noise

## Problem

PR11 created trust-zone storage and PR12 created explicit promotion rules, but
Engram still could not use those zones at recall time. That left the trust-zone
track in an awkward middle state: records could be classified and promoted, yet
the retrieval layer still treated trust as invisible.

For the trust-zone track to improve agent action outcomes, Engram now needs a
bounded retrieval surface that can expose higher-trust context without
accidentally leaking quarantined material back into the prompt.

## Operating Theory

The rollout order still matters:

1. create the store
2. define explicit promotion rules
3. make trust visible at recall time
4. add trust scoring, corroboration, and poisoning defense

This means PR13 should not attempt automatic promotion, trust scoring, or
cross-surface policy blending. It should do one thing: add a first recall
surface that only reads `working` and `trusted` records and keeps `quarantine`
out by default.

## Strategy

The smallest useful retrieval slice is:

- one new config flag: `trustZoneRecallEnabled`
- one bounded recall-pipeline section: `trust-zones`
- one store-side search helper over trust-zone records
- one formatted recall section: `## Trust Zones`

The retrieval contract for this slice is intentionally conservative:

1. never surface `quarantine` records
2. require lexical overlap for non-empty queries
3. rank `trusted` above `working` when both are relevant
4. keep trust-zone recall separate from objective-state and causal recall

That gives the system immediate value without pretending the later poisoning and
corroboration work is already done.

## Key Discoveries

- Trust zones work better as their own recall section first. Blending them
  directly into semantic memory ranking would hide whether the new signal is
  actually helping.
- Excluding `quarantine` by default is the simplest safe default. Operators can
  still inspect quarantine content through status and promotion tooling without
  leaking it into model context.
- Zone priority should be a ranking tie-breaker, not an admission rule. Records
  still need lexical relevance to appear for a non-empty query.
- The same rollout pattern used for objective-state and causal trajectories
  remains the right one here: store, explicit contract, then bounded recall.

## Next Sequence

The trust-zone track now looks like:

1. PR11: trust-zone schemas and storage
2. PR12: promotion rules and provenance enforcement
3. PR13: trust-zone-aware retrieval filters and recall injection
4. PR14+: provenance scoring, corroboration requirements, and poisoning defense

## Open Questions

- Should future trust-aware retrieval blend trust-zone hits into objective-state
  or causal sections once benchmark coverage exists, or should trust remain a
  visibly separate section long term?
- When provenance scoring lands, should `working` records require a minimum
  corroboration score before recall, or is zone membership alone enough for the
  first defense-aware rollout?
- Should later creation-memory and commitment ledgers write directly to
  `working`, or always start in `quarantine` unless promoted explicitly?
