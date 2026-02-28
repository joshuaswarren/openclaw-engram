# Shared Context (v4.0)

Shared-context is a file-based coordination layer that multiple agents can read/write, enabling cross-agent collaboration without direct agent-to-agent messaging.

Default location:
- `~/.openclaw/workspace/shared-context/`

Override:
- `sharedContextDir`

Enable:
- `sharedContextEnabled: true`

## Directory Structure

- `priorities.md`: curated living priority stack (agents read before acting)
- `priorities.inbox.md`: append-only inbox for new priority notes
- `agent-outputs/<agent>/<YYYY-MM-DD>/*.md`: work products written by agents
- `feedback/inbox.jsonl`: append-only approvals/rejections with optional learning/outcome
- `roundtable/<YYYY-MM-DD>.md`: daily synthesis written by the curator tool
- `cross-signals/<YYYY-MM-DD>.json`: deterministic overlap report (topics/entities) across daily outputs + feedback totals

## Tools

- `shared_context_write_output`
- `shared_priorities_append`
- `shared_feedback_record`
- `shared_context_curate_daily`

`shared_context_curate_daily` now writes:
- roundtable markdown (`roundtable/<YYYY-MM-DD>.md`)
- deterministic cross-signal JSON (`cross-signals/<YYYY-MM-DD>.json`)

Cross-signal report includes:
- per-source topic token extraction (from title/body)
- overlap entries where the same token appears across 2+ agents
- daily feedback decision totals (`approved`, `approved_with_feedback`, `rejected`)
- optional semantic overlap enhancement metadata (`semantic.enabled/applied/timedOut`)

Roundtable output includes a `Cross-Signals` section summarizing:
- number of sources analyzed
- number of feedback entries analyzed
- decision totals
- semantic enhancer status (disabled/applied/no-additional-overlap/timeout fail-open)
- path to the generated cross-signal JSON
- top overlap bullets when available

Semantic enhancer settings (all optional):
- `sharedCrossSignalSemanticEnabled` (default `false`)
- `sharedCrossSignalSemanticTimeoutMs` (default `4000`)
- `sharedCrossSignalSemanticMaxCandidates` (default `120`)

Compatibility aliases remain supported:
- `crossSignalsSemanticEnabled`
- `crossSignalsSemanticTimeoutMs`

Injection:
- When enabled, Engram injects `priorities.md` and the latest `roundtable/*.md` into the system prompt (timeboxed and capped by `sharedContextMaxInjectChars`).

## Scheduling

Run `shared_context_curate_daily` as an isolated cron agent turn (recommended) near the end of your day.
