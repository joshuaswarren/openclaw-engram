# Context Retention (v2.4)

v2.4 hardens long-running systems by making summaries richer and enabling optional "semantic recall" over past transcripts.

## Extended Hourly Summaries

Config (all default off):
- `hourlySummariesExtendedEnabled`
- `hourlySummariesIncludeToolStats`
- `hourlySummariesMaxTurnsPerRun`

Output:
- `memoryDir/summaries/hourly/<sessionKey>/<YYYY-MM-DD>.md`
- Each hour is stored as a section with structured subsections.

Tool stats:
- Engram captures tool names during `agent_end` and stores a per-session JSONL under `memoryDir/state/tool-usage/...`.
- Extended summaries can aggregate those counts per hour.

## Scheduling Hourly Summaries

Engram exposes tool `memory_summarize_hourly`. The recommended scheduling approach is an OpenClaw cron job that runs an **isolated agent turn** and calls the tool.

Engram intentionally does not silently modify `~/.openclaw/cron/jobs.json` unless `hourlySummaryCronAutoRegister: true`.

## Conversation Semantic Recall (Optional)

Config (default off):
- `conversationIndexEnabled`
- `conversationIndexQmdCollection` (must exist in `~/.config/qmd/index.yml`)
- `conversationIndexRetentionDays`
- `conversationRecallTopK`
- `conversationRecallMaxChars`
- `conversationRecallTimeoutMs`

How it works:
1. `conversation_index_update` chunks transcript history into markdown docs under:
   - `memoryDir/conversation-index/chunks/<sessionKey>/<YYYY-MM-DD>/*.md`
2. QMD indexes those docs (best-effort, depends on your QMD configuration).
3. On each new prompt, Engram runs a timeboxed semantic query against the conversation chunk collection and injects top-K snippets.

Notes:
- This feature is designed to be fail-open. If indexing/search fails or times out, no context is injected.
- The current implementation uses QMD-backed indexing. `conversationIndexBackend: "faiss"` is reserved.

