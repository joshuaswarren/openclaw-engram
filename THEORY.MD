# Theory: Creation Memory Starts With a Ledger

## Problem

Engram now has stronger evaluators, objective-state memory, causal memory,
trust zones, harmonic retrieval, verified episodic recall, and promoted
semantic rules. What it still lacks is a first-class answer to a basic
operator question:

What did the agent actually create?

That gap matters because recoverability is not only about recalling facts. It
is also about recovering outputs, artifacts, records, and files the agent
already produced.

## Operating Theory

Creation memory should start the same way the other memory-OS tracks started:

1. define a typed durable store
2. gate it behind a flag
3. make writes explicit and inspectable
4. delay retrieval/reuse logic until the substrate is stable

The right first substrate is a work-product ledger:

- one record per created or updated output
- dated, typed, and source-aware
- easy to audit from disk
- narrow enough to test deterministically

This is better than jumping straight to recovery heuristics because later
artifact reuse, commitment linking, and resume bundles all need a stable source
of truth for what the agent made.

## Strategy

Keep PR23 intentionally small:

- add `creationMemoryEnabled`
- add `workProductLedgerDir`
- add a typed `work-product-ledger` store
- add operator-facing record/status commands
- do not yet blend this ledger into recall
- do not yet infer commitments or resume bundles from it

That yields a real creation-memory foundation without pretending the whole
recoverability track is solved.

## Key Discoveries

- Objective-state memory solved "what changed in the world." Creation memory
  solves the adjacent but different question "what did the agent produce."
- A ledger entry should be explicit and source-aware, not inferred from fuzzy
  search. The first rollout should privilege auditability over automation.
- The operator-facing CLI write path is useful here because it gives PR23 a
  real deterministic write surface without taking on transcript inference in
  the same slice.

## Open Questions

- Should PR24 derive artifact reuse candidates directly from the work-product
  ledger, or join ledger entries with objective-state snapshots first?
- Which work-product kinds need dedicated recovery scoring later:
  `artifact`, `file`, `record`, `report`, or something richer?
- When commitments and resume bundles arrive, should they reference ledger
  entries directly or only through shared objective-state / entity refs?
