# Theory: Harmonic Retrieval Needs Abstraction Storage Before It Needs Blending

## Problem

Engram now has a measured evaluation harness, objective-state memory, causal
trajectories, trust zones, provenance scoring, corroboration rules, and typed
red-team benchmark packs. The next roadmap step is harmonic retrieval, but
harmonic retrieval cannot be reviewed sanely if abstraction storage and anchor
logic arrive in the same PR.

If abstraction nodes and cue anchors land together, every retrieval regression
 becomes ambiguous: did the failure come from bad abstraction schema, bad
 anchor construction, or bad blending logic? The system needs a durable
 abstraction contract before it needs mixed retrieval heuristics.

## Operating Theory

The memory-OS rollout keeps working when each retrieval family is decomposed
 into store, writer, retrieval, and policy slices. Harmonic retrieval should
 follow the same pattern:

1. define abstraction-node storage
2. add cue-anchor indexing
3. blend abstractions and anchors into retrieval
4. benchmark whether the blend actually improves recall utility

PR17 is step 1. It should do one thing: make abstraction nodes first-class,
 typed, and inspectable.

That keeps later retrieval work explainable. Reviewers can inspect whether
 abstractions are well-formed before debating how much weight they should have
 against cue anchors or episodic traces.

## Strategy

Keep the abstraction-node contract narrow and deterministic:

- add the two roadmap flags now: `harmonicRetrievalEnabled` and `abstractionAnchorsEnabled`
- add one explicit store directory: `abstractionNodeStoreDir`
- store typed abstraction nodes by day
- expose status counts by abstraction kind and level
- avoid cue-anchor indexing or retrieval blending in this PR

This preserves small-slice discipline. PR17 is not harmonic retrieval. It is
 the smallest bounded storage change that makes harmonic retrieval data visible
 and reviewable before scoring logic appears.

## Key Discoveries

- Harmonic retrieval needs its own storage substrate before it needs ranking.
- Abstraction nodes should encode compression structure, not every cue. Cue
  anchors belong in PR18, where they can be reviewed as their own index layer.
- Operator-facing status commands keep new stores honest. If a new memory layer
  cannot report valid, invalid, latest, and per-type counts, it is still too
  implicit to tune safely.

## Open Questions

- Should future abstraction writers produce one node per session episode, per
  topic cluster, or both?
- Should later abstraction nodes track confidence or source span coverage, or
  can `sourceMemoryIds` stay sufficient until recall blending lands?
- When PR19 arrives, should harmonic blending inject a new dedicated recall
  section first, or blend directly into existing semantic recall ranking?
