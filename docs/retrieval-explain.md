# Retrieval Explain

> Issue #518. **Status: design spec.** The tier-annotation shape, CLI / HTTP / MCP surfaces, and `LastRecallSnapshot.tierExplain` field described below are **not yet shipped** in the current release. This document defines the contract that downstream slices will land against, so operators and plugin authors can review the surface before it arrives. See [advanced-retrieval.md](./advanced-retrieval.md#direct-answer-retrieval-tier-issue-518) for what ships today (pure eligibility function + config keys).
>
> Orthogonal to the graph-path `POST /engram/v1/recall/explain` operation, which already exists and returns a graph explanation document — this design adds a **per-result tier annotation**, not a new graph explainer.

## What it will surface

After a recall, Remnic records a `LastRecallSnapshot` for the calling session (see `packages/remnic-core/src/recall-state.ts`). A planned slice will extend the snapshot with an optional `tierExplain` field populated when the **direct-answer retrieval tier** is enabled (`recallDirectAnswerEnabled: true`):

```ts
// Planned shape — already defined as `RecallTierExplain` in
// packages/remnic-core/src/types.ts, but not yet attached to
// LastRecallSnapshot or populated at runtime.
interface RecallTierExplain {
  tier: "exact-cache" | "fuzzy-cache" | "direct-answer" | "hybrid" | "rerank-graph" | "agentic";
  tierReason: string;        // human-readable summary
  filteredBy: string[];      // filter labels that eliminated at least one candidate
  candidatesConsidered: number;
  latencyMs: number;
  sourceAnchors?: Array<{ path: string; lineRange?: [number, number] }>;
}
```

The first slice that ships runtime behavior will populate `tier: "direct-answer"` only (observation mode). Later slices will populate it for the other tiers.

## Planned surfaces

All three surfaces below are **not yet implemented**. They are documented here as the target contract for the wiring slice. Do not rely on any of them until a subsequent PR lands their implementation; existing `recall/explain` (graph explanation) is unaffected.

### CLI (planned)

```sh
remnic recall-explain [--session <key>] [--format text|json]
```

- **`--session`**: look up a specific session. Omit to read the most recent snapshot across sessions.
- **`--format`**: `text` (default) for human output, `json` for a stable machine-readable payload. Any other value will be rejected — no silent default.

Planned text output for a direct-answer hit:

```
=== Recall Explain ===
session: primary
recorded: 2026-04-19T17:30:00.000Z
namespace: default
source: direct-answer
sources-used: direct-answer
latency-ms: 8
memories: pm

--- tier explain ---
tier: direct-answer
reason: trusted decisions, unambiguous, token-overlap 0.86
candidates-considered: 4
latency-ms: 8
filtered-by: below-token-overlap-floor
source-anchors:
  - /memory/pm.md:10-14
```

When no direct-answer verdict has been recorded the output will still show the snapshot metadata followed by `tier-explain: (not populated — direct-answer tier disabled or did not fire)`.

### HTTP (planned)

```
GET /engram/v1/recall/tier-explain[?session=<key>]
```

Bearer auth (same as other `/engram/v1/*` routes). Will return JSON matching `toRecallExplainJson()`:

```json
{
  "hasExplain": true,
  "snapshotFound": true,
  "sessionKey": "primary",
  "recordedAt": "2026-04-19T17:30:00.000Z",
  "namespace": "default",
  "memoryIds": ["pm"],
  "source": "direct-answer",
  "sourcesUsed": ["direct-answer"],
  "latencyMs": 8,
  "tierExplain": {
    "tier": "direct-answer",
    "tierReason": "trusted decisions, unambiguous, token-overlap 0.86",
    "filteredBy": ["below-token-overlap-floor"],
    "candidatesConsidered": 4,
    "latencyMs": 8,
    "sourceAnchors": [{ "path": "/memory/pm.md", "lineRange": [10, 14] }]
  }
}
```

When no snapshot exists yet, `snapshotFound: false`, `hasExplain: false`, and `tierExplain: null`.

This endpoint is **orthogonal** to the already-shipped `POST /engram/v1/recall/explain`, which returns a graph-path explanation document (the pre-existing `recallExplain` operation). The two paths will coexist under different verbs and URLs.

### MCP (planned)

Planned new tool:

- `remnic.recall_tier_explain` (canonical) / `engram.recall_tier_explain` (legacy alias)
- Optional `sessionKey` argument. Omit to read the most recent snapshot.
- Will return the same JSON payload as the HTTP endpoint.

The existing `engram.recall_explain` MCP tool (graph-path explainer) is unrelated and unchanged.

## Reading the `filteredBy` list

When populated, labels will identify which gate eliminated at least one candidate on the way to the final verdict. They will be emitted regardless of eligibility so downstream consumers can see the narrowing steps.

- `non-active-status` — a candidate was filtered because its status wasn't `active`
- `not-trusted-zone` — candidate's trust zone wasn't `trusted`
- `ineligible-taxonomy-bucket` — candidate's taxonomy bucket wasn't in the allowlist
- `below-importance-floor` — candidate's importance was below the floor AND it wasn't `user_confirmed`
- `entity-ref-mismatch` — caller supplied `queryEntityRefs` and the candidate's `entityRef` wasn't in the set
- `below-token-overlap-floor` — candidate's query↔memory token overlap was below the floor

## Caveats

- Once wired, `tierExplain` will populate only when `recallDirectAnswerEnabled: true` and direct-answer returns a concrete verdict. Disabled-by-default is intentional — see [advanced-retrieval.md](./advanced-retrieval.md) for the rationale.
- The first runtime slice will run direct-answer in **observation mode** (post-recall, no short-circuit). Recall latency will be the sum of the full retrieval path *plus* the eligibility gate (bounded: small corpus ≈ under 10ms, larger corpora scale linearly with memory count).
- The payload's `tierExplain` is designed to be deep-copied defensively by the shared renderer so clients can mutate their local copy without tearing the store.

## Related reading

- [Advanced Retrieval](./advanced-retrieval.md) — sibling tiers (query expansion, re-ranking, feedback loop, procedural recall) and current status of the direct-answer slice.
- Module: `packages/remnic-core/src/direct-answer.ts` — pure eligibility gate `isDirectAnswerEligible(...)` (shipped).
- Module: `packages/remnic-core/src/direct-answer-wiring.ts` — source-agnostic wiring function `tryDirectAnswer(...)` (shipped; not yet invoked by the orchestrator).
- Type: `packages/remnic-core/src/types.ts` → `RecallTierExplain` (shipped as a type; not yet attached to `LastRecallSnapshot`).
- Bench: a dedicated `retrieval-direct-answer` fixture under `packages/bench/src/benchmarks/remnic/` is planned but **not yet in-tree**. Today's in-tree retrieval benchmarks are `retrieval-personalization` and `retrieval-temporal`.
