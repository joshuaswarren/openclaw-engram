# Graph Reasoning

Engram's graph layer is opt-in. It adds explicit graph storage plus bounded traversal on top of the normal recall pipeline; it does not replace the standard retrieval contract.

## Runtime Shape

The shipped graph stack is split into three parts:

1. `multiGraphMemoryEnabled` writes entity, time, and causal edges into the graph store.
2. `graphRecallEnabled` allows the planner to escalate into `graph_mode`.
3. `graphAssistInFullModeEnabled` runs bounded graph expansion during normal `full` recall when enough seed results exist.

The planner still follows the same high-level order:

1. retrieve candidate headroom
2. apply policy filters
3. rerank / graph-assist blend
4. cap to the user-facing budget
5. format and inject

## Core Controls

Use these knobs to bound graph work:

| Setting | Purpose |
|---------|---------|
| `maxGraphTraversalSteps` | Hard ceiling on traversal hops |
| `graphRecallMaxSeedNodes` | Maximum initial seed nodes |
| `graphRecallMaxExpandedNodes` | Maximum expanded nodes kept in one pass |
| `graphRecallMinSeedScore` | Minimum seed quality before traversal begins |
| `graphAssistMinSeedResults` | Minimum non-graph seed results before assist runs in `full` mode |

These are the operator-facing differences between the two graph paths:

| Path | What it changes |
|------|-----------------|
| `graph_mode` | Planner explicitly chooses graph expansion as the recall mode |
| `graphAssistInFullModeEnabled` | Keeps `full` recall as the primary mode and blends graph expansions into it when the seed set is strong enough |

## Explainability and Shadowing

The graph stack is meant to be observable before it is trusted:

- `graphRecallShadowEnabled` keeps graph recall on a telemetry path.
- `graphRecallSnapshotEnabled` writes bounded snapshots under `state/graph/`.
- `graphRecallExplainEnabled` and `graphRecallExplainToolEnabled` expose graph path explanations.
- `graphAssistShadowEvalEnabled` computes the assist path for comparison without changing injected recall output.

## Operational Guidance

- Start with `memoryOsPreset: "balanced"` if you want indexing and artifacts without graph expansion.
- Move to `memoryOsPreset: "research-max"` when you want the broadest shipped graph + learning surface.
- Keep `maxGraphTraversalSteps` small at first. The default `3` is deliberate.
- If graph recall quality regresses, disable `graphRecallEnabled` first, then `multiGraphMemoryEnabled` if you need to stop graph writes entirely.

## Historical Context

Historical v8 plan files describe broader graph ambitions and research rationale. Treat those files as design context only. The GitHub Project and the live config surface are the source of truth for what is currently expected to ship and how operators should enable it.
