# Theory: Creation Memory Also Needs Explicit Obligations

## Problem

PR23 and PR24 made creation memory useful for artifacts:

- PR23 made work products explicit and durable.
- PR24 made those work products recoverable and reusable.

That still leaves the second half of the operator problem:

How does an agent remember what it still owes?

Without explicit commitments, creation memory answers "what did we make?" but
not "what remains promised, pending, or due?"

## Operating Theory

PR25 should stay just as disciplined as the earlier creation-memory slices:

1. reuse the ledger pattern instead of inventing a free-form memory type
2. keep commitments explicit and operator-facing before adding inference
3. separate durable obligation storage from later lifecycle automation
4. add status and write tooling before adding recall or resume-bundle joins

## Strategy

Keep PR25 intentionally small:

- add `commitmentLedgerEnabled`
- add a typed commitment-ledger store
- add `openclaw engram commitment-status`
- add `openclaw engram commitment-record`
- do not yet infer commitments from transcripts
- do not yet add fulfillment or stale-commitment policy
- do not yet build resume bundles from commitments

That yields the first durable obligation substrate while keeping the
creation-memory rollout modular.

## Key Discoveries

- Creation memory has two distinct surfaces: outputs and obligations. Work
  products cover outputs; commitments cover obligations.
- The first commitment slice should be fully explicit and operator-writable.
  If the substrate is fuzzy too early, later lifecycle and resume logic become
  hard to audit.
- Commitment storage should carry enough linkage for later slices:
  `entityRefs`, `workProductEntryRefs`, and `objectiveStateSnapshotRefs` are
  enough for PR26+ without forcing resume logic into PR25.

## Open Questions

- Should PR26 update commitment state in-place or append successor records the
  same way trust-zone promotions append new records?
- Should later commitment recall prioritize deadlines over open follow-ups, or
  should urgency stay a lifecycle concern rather than a retrieval concern?
- When resume bundles land, should they embed full commitment summaries or only
  reference commitment IDs plus compact status fields?
