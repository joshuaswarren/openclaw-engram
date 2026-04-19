# Advanced Retrieval (v2.2)

Engram’s retrieval pipeline can optionally do extra work at recall time to improve relevance.

These features are **disabled by default** to keep latency low and avoid new failure modes.

## Features

### Heuristic Query Expansion (No LLM)

Config:
- `queryExpansionEnabled` (default `false`)
- `queryExpansionMaxQueries` (default `4`)
- `queryExpansionMinTokenLen` (default `3`)

Behavior:
- Runs the original query plus a few deterministic expansions derived from salient tokens.
- Merges and de-dupes results by memory path.

### LLM Re-ranking (Optional)

Config:
- `rerankEnabled` (default `false`)
- `rerankProvider` (default `"local"`)
- `rerankMaxCandidates` (default `20`)
- `rerankTimeoutMs` (default `8000`)
- `rerankCacheEnabled` (default `true`)
- `rerankCacheTtlMs` (default `3600000`)

Behavior:
- Sends up to `rerankMaxCandidates` candidates (ID + snippet) to a short ranking prompt.
- **Fail-open**: on timeout/error, keeps the original ordering.
- Recommended: `rerankProvider: "local"` so this never forces cloud calls.
- Note: `rerankProvider: "cloud"` is reserved/experimental in v2.2.0 and currently behaves as a no-op.

### Feedback Loop (Thumbs Up/Down)

Config:
- `feedbackEnabled` (default `false`)

Tool:
- `memory_feedback` with params:
  - `memoryId`: filename without `.md`
  - `vote`: `up` or `down`
  - `note`: optional

Storage:
- Stored locally at `memoryDir/state/relevance.json`
- Applied as a small score bias during retrieval (bounded; never a hard filter).

### Negative Examples (Retrieved-but-Not-Useful)

Config:
- `negativeExamplesEnabled` (default `false`)
- `negativeExamplesPenaltyPerHit` (default `0.05`)
- `negativeExamplesPenaltyCap` (default `0.25`)

Tools:
- `memory_last_recall`: returns the last recalled memory IDs for a session (or most recent).
- `memory_feedback_last_recall`: batch-mark recalled memory IDs as "not useful" (negative examples).

Storage:
- Negative examples are stored locally at `memoryDir/state/negative_examples.json`.
- Last recall snapshots are stored at `memoryDir/state/last_recall.json`.
- A lightweight, append-only impression log is written to `memoryDir/state/recall_impressions.jsonl`.

Behavior:
- Negative examples apply a **small, bounded penalty** during ranking (soft bias only).
- Safe default: the batch tool requires explicit IDs (or a `usefulMemoryIds` allowlist + `autoMarkOthersNotUseful=true`) to avoid accidental mass-negative marking.

### Procedural memory (optional)

When **`procedural.enabled`** is true, Remnic can inject a short **“Relevant procedures”** section at recall time for prompts that look like **task initiation** (for example deploy, ship, or open a PR), using active `category: procedure` files under `procedures/`. This path is separate from QMD hybrid search and from `memoryKind: procedural` dream-surface filtering.

See [Procedural memory](./procedural-memory.md) for configuration, mining, and the `procedural-recall` benchmark.

### Direct-answer retrieval tier (issue #518)

> **Status (current release): design + pure eligibility function + config keys only.** The orchestrator wiring that would populate a `tierExplain` annotation on the caller's last-recall snapshot — and the CLI / HTTP / MCP surfaces that would expose it — are **not yet shipped**. This section documents the design so downstream slices land against a stable contract. Setting `recallDirectAnswerEnabled: true` in the current release is a no-op at recall time.

Planned behavior: when **`recallDirectAnswerEnabled`** is true, Remnic will run a lightweight eligibility gate alongside QMD to decide whether a single validated memory can answer the query. The first slice that ships runtime behavior will run the gate in observation mode — it will record *which tier would have served the query* onto the caller's last-recall snapshot, so CLI / HTTP / MCP surfaces can surface the decision. A later slice will flip the short-circuit bit and return the direct-answer winner before QMD runs.

What exists today:

- `packages/remnic-core/src/direct-answer.ts` — pure eligibility function (`evaluateDirectAnswer`) exercised by unit tests and the `retrieval-direct-answer` bench fixture.
- `packages/remnic-core/src/direct-answer-wiring.ts` — `tryDirectAnswer(...)` source-agnostic binding, callable by tests and bench harnesses but not yet invoked by the orchestrator.
- The five `recallDirectAnswer*` config keys below (parsed and validated; no runtime callers yet).

Planned eligibility ladder (in order, unchanged between observation and short-circuit modes):

1. `config.recallDirectAnswerEnabled === false` → reason `disabled`
2. Query normalizes to zero searchable tokens → reason `empty-query`
3. No candidate memories → reason `no-candidates`
4. Hard filters drop all candidates (status ≠ active, not `trusted` zone, ineligible taxonomy bucket, importance below floor AND not `user_confirmed`, entity-ref hint mismatch) → reason `no-eligible-candidates`
5. Token-overlap floor drops all survivors → reason `below-token-overlap-floor`
6. Top two candidates within `recallDirectAnswerAmbiguityMargin` of each other → reason `ambiguous`
7. Otherwise → reason `eligible`, winner annotated on the snapshot

Config keys (already parsed by `config.ts`; inert at recall time until the wiring slice lands):

- `recallDirectAnswerEnabled` (default `false`) — master switch
- `recallDirectAnswerTokenOverlapFloor` (default `0.55`, `0` to disable the gate)
- `recallDirectAnswerImportanceFloor` (default `0.7`, `0` to disable the gate)
- `recallDirectAnswerAmbiguityMargin` (default `0.15`)
- `recallDirectAnswerEligibleTaxonomyBuckets` (default `["decisions","principles","conventions","runbooks","entities"]`)

See [Retrieval explain](./retrieval-explain.md) for the planned shape of the tier annotation and the CLI / HTTP / MCP surfaces that will expose it.

## Example: Enable Local-only Re-ranking

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-engram": {
        "config": {
          "rerankEnabled": true,
          "rerankProvider": "local",
          "rerankMaxCandidates": 20,
          "rerankTimeoutMs": 8000
        }
      }
    }
  }
}
```

## Debugging Slow Calls (Metadata-only)

Config:
- `slowLogEnabled` (default `false`)
- `slowLogThresholdMs` (default `30000`)

When enabled, Engram logs warnings like:
- `SLOW local LLM: op=rerank durationMs=...`
- `SLOW QMD query: durationMs=...`

These logs never include user content.
