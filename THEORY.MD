# Theory: Trust Zones Need Retrieval First and Trust Signals Second

## Problem

Trust zones are now a real Engram substrate: storage exists, explicit promotion
rules exist, and recall can now surface `working` and `trusted` records without
leaking `quarantine` by default. The next missing piece is still defensive
clarity. Without an explicit provenance signal, later poisoning-defense work
would have to infer trust indirectly from scattered promotion logic and zone
membership alone.

That would make the defense track hard to benchmark and easy to regress. The
right next step is not full corroboration or attack simulation yet. It is to
make provenance quality measurable.

## Operating Theory

The trust-zone rollout is working because it has stayed ordered:

1. store the trust tiers
2. define bounded promotion rules
3. expose a safe retrieval surface
4. add explicit trust signals
5. only then automate policy

PR13 completed step 3 by making trust visible at recall time. PR14 is step 4:
derive one deterministic trust score from the provenance already stored on each
record.

That score is useful even before it changes decisions because it turns "trust"
from an implicit idea into a contract that tests, operators, and later PRs can
all inspect.

## Strategy

Keep the slice narrow and defaults-off:

- leave the PR13 recall contract intact
- compute trust from stored provenance only
- expose the score in trust-zone status, not promotion automation
- leave corroboration and red-team attack suites for later slices

This keeps the roadmap honest. Retrieval answers whether a record should be
visible at all. Provenance scoring starts answering how strong the evidence is
behind records that are already visible.

## Key Discoveries

- Trust-zone recall and trust scoring are complementary, not competing, slices.
  Recall should stay bounded by zone plus lexical relevance; scoring should stay
  bounded by provenance quality.
- Provenance trust should be deterministic for a stored record. If the score
  depends on query context or wall-clock timing, benchmark comparisons become
  harder to trust.
- The first score does not need model judgment. Source class plus explicit
  anchors (`sourceId`, `evidenceHash`, `sessionKey`) is enough to establish a
  useful first trust floor.
- Trust scoring belongs in operator-visible status output first. That makes the
  defense signal reviewable before later PRs rely on it for policy.

## Open Questions

- Should PR15 treat trust score as advisory context layered on top of
  corroboration, or as part of promotion eligibility itself?
- Should later retrieval slices use trust score only as a tie-breaker, or
  should some low-trust material be filtered entirely once benchmark evidence
  exists?
- When PR16 adds red-team benchmark packs, should they assert on raw score
  breakdowns, aggregate bands, or downstream promotion/retrieval outcomes?
