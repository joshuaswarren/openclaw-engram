# Theory: Verified Episodic Recall Should Reuse Boxes, But Verify The Sources

## Problem

Engram already has two different substrates that could plausibly support
episodic recall:

- memory boxes, which group related extractions into bounded episodes
- individual memory files, which still carry the actual `memoryKind` and
  lifecycle status

The mistake would be to invent a third episodic store just to satisfy the
paper-level requirement for verified episodic recall. That would duplicate the
same episode shape in another place, add more drift risk, and make later
benchmarking harder because it would no longer be obvious which substrate
should be trusted when they disagree.

PR20 is about proving that Engram can retrieve episodes in a stricter way
without adding another store: reuse boxes for the retrieval window, but verify
their cited source memories before surfacing them.

## Operating Theory

The rollout pattern that has worked across the memory-OS track is still the
right one:

1. keep the new capability bounded and inspectable
2. reuse existing durable substrates when they already encode the right shape
3. add verification rules before automation rules
4. benchmark the verified surface before promoting more abstract behavior

For episodic versus semantic memory, the highest-leverage distinction today is
not a new schema. It is recall-time verification:

- boxes say "this cluster of memories looked like one episode"
- source memories say "these cited memories are still episodes and not archived"

That means the first verified recall slice should admit a box only when at
least one cited memory still verifies as a live episode. If the box has only
notes, archived memories, or broken references, it should not surface in the
verified episodic section even if its topics look relevant.

## Strategy

Keep PR20 narrow and legible:

- add a dedicated recall section: `verified-episodes`
- rank recent boxes by lexical overlap over:
  - topics
  - goal
  - tools used
  - verified episodic memory content
- verify each candidate box by resolving its `memoryIds` back through storage
- only admit boxes with at least one non-archived `memoryKind: episode` source
- expose an operator diagnostic command:
  - `openclaw engram verified-recall-search <query>`

This keeps the feature aligned with the human-inspired memory direction without
pretending semantic rule promotion is ready yet. The first slice should answer
one question clearly: can Engram surface episodes that are still grounded in
verified episodic source memories?

## Key Discoveries

- Memory boxes are already the right retrieval envelope for episodic recall.
  The missing piece was verification of their cited memories, not another
  persistence layer.
- Verification also has to be cheap enough for the recall path. Resolving
  cited `memoryIds` by repeated `getMemoryById()` calls quietly degenerates
  into repeated full-corpus scans, so the verified episodic slice needs one
  preloaded memory map per search rather than per-box lookups.
- Verified episodic recall fits the existing recall-pipeline model cleanly as a
  separate section. It does not need to mutate generic semantic recall yet.
- `semanticRulePromotionEnabled` belongs in the config contract now, but only
  as a declared future gate. The current slice should not claim semantic-rule
  extraction or promotion behavior before that surface is benchmarked.

## Open Questions

- Should later slices downgrade partially verified boxes, or should verified
  recall remain binary until benchmark data says otherwise?
- When semantic-rule promotion lands, should it derive only from verified
  episodic memories, or can stable note memories also participate after an
  explicit verification step?
- Should a future verified-recall benchmark score source-memory coverage
  directly, or is box-level admission enough for the first round of evaluation?
