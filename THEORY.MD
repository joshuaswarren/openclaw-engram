# Theory: Trust Zones Need Explicit Promotion Rules Before Retrieval Filtering

## Problem

PR11 created a trust-zone store, but storage alone does not change behavior.
Without explicit promotion rules, every future writer would still have to invent
its own ad hoc interpretation of what it means to move something from
`quarantine` to `working` or from `working` to `trusted`.

That would recreate the same ambiguity the store layer was supposed to remove.
The next step is therefore not retrieval filtering yet. The next step is a
single promotion contract that defines what is allowed, what is blocked, and
what provenance is required before higher-trust storage exists.

## Operating Theory

The memory-OS roadmap is still working because each new surface is arriving in
strict order:

1. typed store
2. explicit write/promotion contract
3. retrieval surface
4. stronger defenses and automation

For trust zones, that means PR12 should do three things and stop:

- define promotion eligibility rules
- enforce minimum provenance for risky promotions
- write lineage-aware successor records instead of mutating source records

That preserves the value of PR11's storage boundary and creates a stable base
for PR13 retrieval filters and PR14+ poisoning-defense work.

## Strategy

The product thesis still governs the sequence:

- memory that improves action outcomes
- memory that survives long horizons and failures
- memory that can defend itself

For the trust-zone track, that translates to:

1. allow `quarantine -> working`
2. allow `working -> trusted` only through an explicit guarded path
3. block `quarantine -> trusted`
4. require anchored provenance before external/tool-derived material can become
   `trusted`
5. keep all of it defaults-off behind the existing flags

This keeps the slice small enough for review while making later retrieval and
defense work less ambiguous.

## Key Discoveries

- Promotion should write a new successor record, not mutate the source. Lineage
  matters for audits and later poisoning analysis.
- Direct `quarantine -> trusted` promotion is too permissive for the first
  trust-aware path. Forcing `working` as an intermediate zone makes later
  corroboration rules easier to add.
- Provenance enforcement can start smaller than full corroboration. Requiring
  anchored provenance (`sourceId` + `evidenceHash`) for risky `working ->
  trusted` promotions gives the system a real minimum trust floor without
  front-loading PR15's corroboration logic.
- A dry-run CLI path is enough operator control for this slice. Automatic
  promotion can wait until the trust contract has more real-world exposure.

## Next Sequence

The trust-zone roadmap now looks like:

1. PR11: trust-zone schemas and storage
2. PR12: promotion rules and provenance enforcement
3. PR13: trust-zone-aware retrieval filters
4. PR14+: trust scoring, corroboration, and poisoning defense

## Open Questions

- Should future automatic writers target `working` by default for some source
  classes, or should everything still enter through `quarantine` first?
- Should promotion reasons remain in record metadata long term, or move into a
  dedicated append-only promotion ledger in a later slice?
- When PR13 lands, should trust-zone retrieval filtering apply uniformly across
  objective-state and causal-trajectory sections, or should the rollout start
  with one retrieval surface first?
