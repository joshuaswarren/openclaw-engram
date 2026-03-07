# Theory: Engram Is Converting Stored Trajectories Into Usable Recall

## Problem

The causal-memory track is now past the storage-only phase. Engram can persist
typed goal-action-observation-outcome-follow-up chains and can translate them
into deterministic graph edges, but neither of those steps helps an agent
unless recall can surface the right trajectory at the moment a prompt asks for
it.

The immediate problem is therefore not richer graph structure. It is making the
stored causal evidence usable without overcommitting to a complex retrieval
system too early. PR10 needs to prove that trajectory-aware recall can be
useful in a bounded, defaults-off form before later slices add graph traversal,
cross-linking, or heavier ranking.

## Operating Theory

The causal-memory rollout is working because it has stayed disciplined:

1. store the typed source of truth
2. bridge that source into durable graph structure
3. add a small retrieval surface
4. benchmark and harden before blending deeper into the main ranking path

That means PR10 should not try to “solve causal retrieval” in one pass. The
right first retrieval layer is store-side lexical search over trajectory fields
that already carry the useful causal information:

- `goal`
- `actionSummary`
- `observationSummary`
- `outcomeSummary`
- `followUpSummary`
- tags / entity refs / objective-state refs

That gives Engram a prompt-relevant `## Causal Trajectories` section with
lightweight explainability (`matched: ...`) while keeping the behavior legible
and easy to benchmark.

## Strategy

The broader thesis remains:

- memory that improves action outcomes
- memory that survives long horizons and failures
- memory that can defend itself

For the causal track, the strategy is now:

1. keep retrieval behind a dedicated flag and recall-pipeline section
2. use conservative lexical admission rather than premature graph heuristics
3. surface formatted chains as a separate recall section first
4. use that bounded surface to inform the later graph-aware retrieval slice

This keeps PR10 small and reviewable while preserving the roadmap sequence:

1. PR8: causal trajectory store
2. PR9: action-conditioned graph writer
3. PR10: trajectory-aware recall and explainability

## Key Discoveries

- A separate recall section is the cleanest first integration point. It makes
  the new capability visible to agents without perturbing the existing semantic
  memory ranking path.
- The first false positive in trajectory search came from common-language token
  noise rather than genuine causal similarity. Lightweight stopword filtering
  is enough for this slice; heavier graph traversal can wait.
- Explainability does not need a second model pass. Exposing which trajectory
  fields matched the prompt is sufficient for an operator-facing first version.

## Open Questions

- When PR11+ introduces trust zones, should causal trajectory recall be filtered
  by promotion tier before formatting?
- Should later graph-aware retrieval use the trajectory store as the primary
  recall source and the graph as expansion support, or should that relationship
  invert?
- Which benchmark cases best distinguish useful causal recall from merely
  plausible-looking chain retrieval?
