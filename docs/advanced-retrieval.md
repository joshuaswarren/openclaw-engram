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

