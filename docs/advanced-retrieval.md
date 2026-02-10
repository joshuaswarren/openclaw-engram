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
