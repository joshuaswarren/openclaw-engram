# Retrieval Explain

> Issue #518. Shows which retrieval tier served the caller's last recall, plus the reason, filter trail, and source anchors. Orthogonal to the graph-path `recall/explain` operation: this is a per-result annotation, that is a user-invoked RPC.

## What it surfaces

After a recall, Remnic records a `LastRecallSnapshot` for the calling session (see `packages/remnic-core/src/recall-state.ts`). When the **direct-answer retrieval tier** is enabled (`recallDirectAnswerEnabled: true`), the orchestrator annotates that snapshot with a `RecallTierExplain` block:

```ts
interface RecallTierExplain {
  tier: "exact-cache" | "fuzzy-cache" | "direct-answer" | "hybrid" | "rerank-graph" | "agentic";
  tierReason: string;        // human-readable summary
  filteredBy: string[];      // filter labels that eliminated at least one candidate
  candidatesConsidered: number;
  latencyMs: number;
  sourceAnchors?: Array<{ path: string; lineRange?: [number, number] }>;
}
```

In the current release the orchestrator only populates `tier: "direct-answer"` (observation mode). Future slices will populate it for the other tiers.

## Surfaces

### CLI

```sh
remnic recall-explain [--session <key>] [--format text|json]
```

- **`--session`**: look up a specific session. Omit to read the most recent snapshot across sessions.
- **`--format`**: `text` (default) for human output, `json` for a stable machine-readable payload. Any other value is rejected — no silent default.

Example text output for a direct-answer hit:

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

When no direct-answer verdict has been recorded the output still shows the snapshot metadata followed by `tier-explain: (not populated — direct-answer tier disabled or did not fire)`.

### HTTP

```
GET /engram/v1/recall/tier-explain[?session=<key>]
```

Bearer auth (same as other `/engram/v1/*` routes). Returns JSON matching `toRecallExplainJson()`:

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

This endpoint is **orthogonal** to `POST /engram/v1/recall/explain`, which returns a graph-path explanation document (the pre-existing `recallExplain` operation).

### MCP

New tool:

- `remnic.recall_tier_explain` (canonical) / `engram.recall_tier_explain` (legacy alias)
- Optional `sessionKey` argument. Omit to read the most recent snapshot.
- Returns the same JSON payload as the HTTP endpoint.

## Reading the `filteredBy` list

Labels identify which gate eliminated at least one candidate on the way to the final verdict. They are emitted regardless of eligibility so downstream consumers can see the narrowing steps.

- `non-active-status` — a candidate was filtered because its status wasn't `active`
- `not-trusted-zone` — candidate's trust zone wasn't `trusted`
- `ineligible-taxonomy-bucket` — candidate's taxonomy bucket wasn't in the allowlist
- `below-importance-floor` — candidate's importance was below the floor AND it wasn't `user_confirmed`
- `entity-ref-mismatch` — caller supplied `queryEntityRefs` and the candidate's `entityRef` wasn't in the set
- `below-token-overlap-floor` — candidate's query↔memory token overlap was below the floor

## Caveats

- `tierExplain` is populated only when `recallDirectAnswerEnabled: true` and direct-answer returned a concrete verdict. Disabled-by-default is intentional — see [advanced-retrieval.md](./advanced-retrieval.md) for the rationale.
- The current release runs direct-answer in **observation mode** (post-recall, no short-circuit). Recall latency is the sum of the full retrieval path *plus* the eligibility gate (bounded: small corpus ≈ under 10ms, larger corpora scale linearly with memory count).
- The payload's `tierExplain` is deep-copied defensively (see `recall-explain-renderer.ts`). Clients can mutate their local copy without tearing the store.

## Related reading

- [Advanced Retrieval](./advanced-retrieval.md) — sibling tiers (query expansion, re-ranking, feedback loop, procedural recall)
- Module: `packages/remnic-core/src/direct-answer.ts` — pure eligibility gate
- Module: `packages/remnic-core/src/direct-answer-wiring.ts` — source-agnostic wiring
- Module: `packages/remnic-core/src/recall-explain-renderer.ts` — shared CLI / HTTP / MCP formatter
- Bench: `packages/bench/src/benchmarks/remnic/retrieval-direct-answer/` — synthetic precision + latency fixture
