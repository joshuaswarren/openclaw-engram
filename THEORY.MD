# Theory: Commitments Need Lifecycle, Not Just Storage

## Problem

PR25 established that commitments deserve a typed ledger instead of living only
as transcript residue. That solved durability, but it did not yet solve
operability. A ledger that can only append `open` promises is still missing the
behavior that makes commitments useful in real agent work:

- agents need to mark obligations fulfilled or cancelled,
- overdue commitments need deterministic expiry pressure,
- resolved commitments should not accumulate forever once they age out.

Without that lifecycle layer, commitment memory remains inspectable but not
maintainable.

## Operating Theory

The right PR26 shape is still a narrow storage-first slice. Commitment
lifecycle should be deterministic and auditable before any inference or resume
automation lands.

That means:

- keep lifecycle attached to the typed commitment ledger,
- add explicit state transitions instead of transcript-derived guesses,
- make stale and overdue signals visible in status first,
- reuse the existing `commitmentDecayDays` cleanup horizon instead of inventing
  a parallel retention policy.

The commitment ledger is becoming the creation-memory substrate for obligations
the same way the work-product ledger became the substrate for outputs.

## Strategy

PR26 stays small by adding only three levers:

1. explicit lifecycle metadata and a state-transition path for existing entries
2. deterministic lifecycle accounting for overdue, stale, and decay-eligible
   commitments
3. a lifecycle runner that expires overdue commitments and cleans aged resolved
   entries, plus consolidation wiring so the behavior is not CLI-only

This avoids three kinds of sprawl:

- no transcript inference,
- no resume-bundle generation,
- no ranking or recall layer for commitments yet.

## Key Discoveries

- Commitment memory has the same rollout shape as the other memory OS tracks:
  store first, then lifecycle, then recall/recovery consumers.
- A lifecycle slice is more useful when it is operator-driven and predictable
  than when it tries to infer intent from loose conversation text.
- `commitmentDecayDays` already encodes the retention horizon for resolved
  commitments in legacy memory cleanup, so PR26 should extend that policy to
  the typed ledger instead of creating a second contradictory timer.
- Overdue and stale are not the same thing: overdue is deadline-backed and can
  auto-expire; stale is deadline-free drift that should become visible before
  any stronger automation is added.

## Open Questions

- Should a later recall slice surface open commitments directly as their own
  section, or should commitments only feed resume bundles and operator tooling?
- When resume bundles arrive, should they include raw commitment summaries or a
  more compact status view with links back to the ledger?
- Should later slices keep in-place lifecycle updates, or move to append-only
  transition history once the obligation model stabilizes?
