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

## Tools

- `shared_context_write_output`
- `shared_priorities_append`
- `shared_feedback_record`
- `shared_context_curate_daily`

Injection:
- When enabled, Engram injects `priorities.md` and the latest `roundtable/*.md` into the system prompt (timeboxed and capped by `sharedContextMaxInjectChars`).

## Scheduling

Run `shared_context_curate_daily` as an isolated cron agent turn (recommended) near the end of your day.

