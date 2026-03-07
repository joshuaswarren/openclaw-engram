# Theory: Engram As A Measured Memory OS

## Problem

PR7 closed the first objective-state loop: Engram can now recall prompt-relevant
world-state snapshots as a separate section. That improves access to what
actually happened, but it still does not capture why a sequence of actions led
to an outcome. Objective-state snapshots are atomic. Agentic memory needs the
next layer above them: typed causal chains that preserve goal, action,
observation, outcome, and intended follow-up.

The current problem is therefore not retrieval breadth. It is structural memory
shape. Without a causal-trajectory store, later graph and retrieval work would
have to infer trajectory records from raw snapshots or transcripts after the
fact, which is noisy and hard to benchmark.

## Operating Theory

Causal-memory work should begin the same way objective-state memory did: store
first, use later. A typed on-disk store is the right first move because it
creates a stable contract for later writers, graph builders, and retrievers
without forcing premature ranking logic into the live recall path.

The contract for this slice is a normalized causal record:

- goal
- action summary
- observation summary
- outcome kind and outcome summary
- optional follow-up summary
- optional refs back to objective-state snapshots and entities

That record is intentionally narrower than a full action graph. The point is to
preserve causal structure with minimal interpretation so later slices can build
action-conditioned edges and retrieval on top of a durable source of truth.

## Strategy

The roadmap is still benchmark-first, flag-first, and slice-first. Each memory
surface lands in this order:

1. storage contract
2. writer path
3. retrieval or planner integration
4. benchmark tightening

For the causal track, that means:

1. PR8: causal trajectory schema and storage
2. PR9: action-conditioned graph construction
3. PR10: trajectory-aware retrieval and explainability

This keeps the larger thesis intact:
- memory that improves action outcomes
- memory that survives long horizons and failures
- memory that can defend itself

## Key Discoveries

- Objective-state recall made it clearer that snapshots and trajectories solve
  different problems. Snapshots answer "what changed"; trajectories answer
  "what chain of intent and consequence produced this state."
- Starting with a store-only slice is the safest way to add causal structure.
  It avoids inventing retrieval heuristics before the storage contract is
  stable.
- Causal-memory records should link back to objective-state snapshot IDs rather
  than duplicate snapshot payloads. The trajectory layer should compose the
  existing state layer, not fork it.

## Open Questions

- Which live hook should become the first causal-trajectory writer in PR9
  without overfitting to one provider or one transcript shape?
- How much of the causal chain should be extracted heuristically versus written
  directly from structured runtime events?
- Which benchmark cases best expose trajectory-quality regressions once
  trajectory-aware retrieval lands?
