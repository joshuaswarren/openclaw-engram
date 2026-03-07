# Theory: Verified Episodes Should Feed Narrow Semantic Rule Promotion

## Problem

PR20 proved that Engram can reuse memory boxes for episodic recall while still
verifying the cited source memories. The next mistake would be to stop there
and leave semantic memory disconnected from those verified episodes. The memory
model from the roadmap is not just "retrieve episodes"; it is "retrieve
episodes, verify them, and separately extract reusable semantic rules."

That means PR21 needs a promotion path from verified episodic material into
durable rule memory. The danger is scope creep: a broad "semantic rule" system
would immediately pull in model inference, ranking, downgrade policy, and
retrieval blending. This slice needs to stay smaller than that.

## Operating Theory

The rollout pattern that has worked across the memory-OS track is still right:

1. keep the new capability bounded and inspectable
2. reuse existing durable substrates when they already encode the right shape
3. add verification rules before automation rules
4. benchmark the verified surface before promoting more abstract behavior

For semantic rule promotion, the highest-leverage first step is not general
causal inference. It is deterministic promotion of already-explicit rules from
verified episodic memories:

- episodic memories remain the source of truth
- promoted `rule` memories become the reusable semantic layer
- lineage and source-memory provenance keep the semantic layer auditable

If the source memory is not a live episode, or if it does not contain an
explicit `IF ... THEN ...` structure, this slice should do nothing.

## Strategy

Keep PR21 narrow and legible:

- keep everything behind `semanticRulePromotionEnabled`
- add an operator-facing command:
  - `openclaw engram semantic-rule-promote --memory-id <id> [--dry-run]`
- accept only non-archived source memories whose `memoryKind` is `episode`
- normalize only explicit `IF ... THEN ...` rules
- write promoted rules as normal `rule` memories with:
  - `memoryKind: note`
  - `source: semantic-rule-promotion`
  - `sourceMemoryId`
  - `lineage`
  - support link back to the source episode
- suppress duplicates by canonicalized rule content

This keeps the feature aligned with the human-inspired memory direction without
pretending the full semantic-rule system exists yet. The first question is
simply: can Engram take an already-explicit rule from a verified episode and
promote it into durable semantic memory with provenance intact?

## Key Discoveries

- The repo already had a `rule` memory category and causal-rule-aware
  extraction prompts, but it still lacked an explicit promotion path from
  episodic evidence into durable rule memory.
- The cleanest first semantic-rule slice is deterministic rather than model
  inferred: promote only explicit `IF ... THEN ...` clauses that are already
  present in verified episodic memories.
- Canonicalization matters immediately. If punctuation around the condition
  clause is not normalized, duplicate suppression will drift and rule memories
  will split on commas rather than meaning.
- Provenance needs to be written on day one. `sourceMemoryId`, `lineage`, and a
  support link back to the episode are the minimum structure that makes later
  downgrade and verifier work possible.

## Open Questions

- Should later slices broaden promotion beyond explicit `IF ... THEN ...`
  phrasing into causal paraphrases like "X failed because Y"?
- Should semantic-rule recall stay separate from principle/rule recall until
  downgrade paths exist, or is provenance alone enough for early blending?
- When PR22 adds verifier and confidence downgrade behavior, should duplicate
  rule detection also compare lineage sets, or is normalized content enough?
