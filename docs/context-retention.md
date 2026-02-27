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
- `conversationIndexBackend` (`qmd` default, `faiss` optional)
- `conversationIndexQmdCollection` (must exist in `~/.config/qmd/index.yml` when backend is `qmd`)
- `conversationIndexFaissScriptPath`, `conversationIndexFaissPythonBin`, `conversationIndexFaissModelId`, `conversationIndexFaissIndexDir` (used when backend is `faiss`)
- `conversationIndexFaissUpsertTimeoutMs`, `conversationIndexFaissSearchTimeoutMs`, `conversationIndexFaissHealthTimeoutMs`
- `conversationIndexFaissMaxBatchSize`, `conversationIndexFaissMaxSearchK`
- `conversationIndexRetentionDays`
- `conversationRecallTopK`
- `conversationRecallMaxChars`
- `conversationRecallTimeoutMs`

How it works:
1. `conversation_index_update` chunks transcript history into markdown docs under:
   - `memoryDir/conversation-index/chunks/<sessionKey>/<YYYY-MM-DD>/*.md`
2. Backend-specific indexing runs best-effort:
   - `qmd`: indexes those docs through QMD.
   - `faiss`: uses the FAISS sidecar for upsert/search artifacts under the configured FAISS index directory.
3. On each new prompt, Engram runs a timeboxed semantic query via the selected backend and injects top-K snippets.

Notes:
- This feature is designed to be fail-open. If indexing/search fails or times out, no context is injected.
- Keep `conversationIndexBackend: "qmd"` as baseline; enable `faiss` incrementally during rollout.

