# Theory: Promoted Rules Need Recall-Time Verification

## Problem

PR21 proved Engram can turn explicit `IF ... THEN ...` clauses from verified
episodes into durable rule memories. That created a new risk: promoted rules
can outlive the episode that justified them. If Engram treats those rules as
durable truth forever, semantic memory becomes easier to poison and harder to
audit.

The next step is not broad rule retrieval or invalidation. It is narrower:
re-check promoted rules against their cited source episode at recall time and
only surface rules whose provenance still carries enough weight.

## Operating Theory

The rollout that has worked across the memory-OS track still applies here:

1. store the durable thing first
2. verify it again when it matters
3. downgrade confidence before mutating state
4. keep the new recall surface separate until it is benchmarked

For promoted semantic rules, recall-time verification is the smallest honest
bridge between episodic truth and semantic reuse:

- promoted `rule` memories remain durable and inspectable
- the cited `sourceMemoryId` remains the audit anchor
- recall re-checks that source before surfacing the rule
- missing, archived, or non-episodic sources reduce effective confidence

That keeps semantic memory useful without pretending provenance never decays.

## Strategy

Keep PR22 bounded and feature-flagged:

- add `semanticRuleVerificationEnabled`
- add a dedicated `## Verified Rules` recall section
- search only `rule` memories written by `semantic-rule-promotion`
- re-check the cited `sourceMemoryId` at recall time
- compute an effective confidence:
  - verified source: keep anchored confidence
  - missing/archived/non-episode source: downgrade it
- filter out downgraded rules below a default confidence floor
- expose the exact surface through:
  - `openclaw engram semantic-rule-verify <query>`

This keeps the verifier inspectable and benchmarkable before any broader
semantic blending lands.

## Key Discoveries

- PR21 already wrote the critical provenance fields: `sourceMemoryId`,
  `lineage`, and a `supports` link. That made PR22 possible without changing
  storage shape.
- Confidence downgrade is the right first response to provenance decay. It is
  cheaper and safer than mutating or deleting rule memories during recall.
- A separate `Verified Rules` section is cleaner than blending promoted rules
  into generic recall immediately. It makes the new behavior legible and easier
  to benchmark.

## Open Questions

- Should a future slice record verifier outcomes back onto the rule memory, or
  should recall stay purely read-only?
- When broader semantic-rule retrieval arrives, should verified rules blend
  with principles, or stay in a distinct section until benchmark results prove
  parity?
- Do later slices need learned downgrade weights, or is deterministic
  provenance scoring enough for the semantic-rule track?
