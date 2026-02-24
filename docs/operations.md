# Operations

## Backup, Export, and Import

Engram supports portable exports and safe backups via CLI.

### Export

```bash
# JSON bundle (recommended for migration)
openclaw engram export --format json --out /tmp/engram-export

# SQLite database
openclaw engram export --format sqlite --out /tmp/engram.sqlite

# Markdown bundle (human-readable)
openclaw engram export --format md --out /tmp/engram-md
```

### Import

```bash
openclaw engram import --from /tmp/engram-export --format auto
```

### Backup with Retention

```bash
openclaw engram backup --out-dir /tmp/engram-backups --retention-days 14
```

With namespaces (v3.0):

```bash
openclaw engram export --namespace shared --format json --out /tmp/shared-export
```

→ Full details: [docs/import-export.md](import-export.md)

## CLI Commands

```bash
openclaw engram search "query"      # Semantic search
openclaw engram stats               # Memory counts and index state
openclaw engram topics              # View extracted topic list
openclaw engram threads             # View conversation threads
openclaw engram access              # Most-accessed memories
openclaw engram export              # Export memory store
openclaw engram import              # Import memory store
openclaw engram backup              # Create timestamped backup
```

## Hourly Summaries (Cron)

Engram can generate hourly summaries of conversation activity.

Recommended cron setup (via OpenClaw agent turn — avoids `main` session restrictions):

```jsonc
// openclaw.json cron entry
{
  "schedule": "0 * * * *",
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "content": "Call the memory_summarize_hourly tool."
  },
  "delivery": { "mode": "none" }
}
```

Enable extended summaries:

```jsonc
{
  "hourlySummariesExtendedEnabled": true,
  "hourlySummariesIncludeToolStats": false
}
```

## Cron Recall Policy

Engram supports cron-specific recall policy so you can keep high-frequency automation jobs cheap while still enabling memory context for selected cron sessions.

```jsonc
{
  "cronRecallMode": "allowlist",
  "cronRecallAllowlist": [
    "*:cron:deckard-morning-briefing:*",
    "*:cron:deckard-evening-reflection:*"
  ],
  "cronRecallPolicyEnabled": true,
  "cronRecallNormalizedQueryMaxChars": 480,
  "cronRecallInstructionHeavyTokenCap": 36,
  "cronConversationRecallMode": "auto"
}
```

Modes:
- `all`: all cron sessions can use recall.
- `none`: all cron sessions skip recall.
- `allowlist`: only cron session keys matching wildcard patterns (`*`) can use recall.

Query stability controls:
- `cronRecallPolicyEnabled`: normalizes cron retrieval queries (especially large instruction-heavy prompts).
- `cronRecallNormalizedQueryMaxChars`: caps normalized query length.
- `cronRecallInstructionHeavyTokenCap`: caps compacted-token query size for instruction-heavy prompts.
- `cronConversationRecallMode`: `auto` skips conversation semantic recall only for instruction-heavy cron prompts, `always` keeps it enabled for all cron prompts, `never` always skips it.

Pattern tip:
- Session keys include `:cron:<job-id>:`. Match by job id for stability, for example `*:cron:engram-hourly-summary-v24:*`.

## File Hygiene

Engram can optionally lint and rotate large workspace files that are bootstrapped into the prompt (e.g. `IDENTITY.md`). Without rotation, an oversized file can be silently truncated by the gateway.

```jsonc
{
  "fileHygiene": {
    "enabled": true,
    "lintEnabled": true,
    "lintPaths": ["IDENTITY.md", "MEMORY.md"],
    "lintBudgetBytes": 20000,
    "lintWarnRatio": 0.8,
    "rotateEnabled": true,
    "rotatePaths": ["IDENTITY.md"],
    "rotateMaxBytes": 18000,
    "rotateKeepTailChars": 2000,
    "archiveDir": ".engram-archive",
    "runMinIntervalMs": 300000
  }
}
```

## Gateway Restart Commands

```bash
# Full restart (fires gateway_start hook — required for config changes)
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# Hot reload (does NOT fire gateway_start)
kill -USR1 $(pgrep openclaw-gateway)
```

## Logs

```bash
# Watch gateway logs for engram activity
tail -f ~/.openclaw/logs/gateway.log | grep '\[engram\]'

# Slow operations appear in gateway logs as warnings (if slowLogEnabled)
grep -i 'slow\|latency' ~/.openclaw/logs/gateway.log | tail -20
```

## Memory Store Maintenance

```bash
# Re-index all memories in QMD after manual changes
qmd update --collection openclaw-engram
qmd embed --collection openclaw-engram

# View dedup hash index size
wc -l ~/.openclaw/workspace/memory/local/state/fact-hashes.txt
```

## Identity Continuity Anchor

When `identityContinuityEnabled=true`, agents can manage the recovery anchor via tools:

- `identity_anchor_get` reads the current anchor.
- `identity_anchor_update` merges updates into anchor sections (`Identity Traits`, `Communication Preferences`, `Operating Principles`, `Continuity Notes`) without destructive overwrite.

Anchor file location:

```text
<memoryDir>/identity/identity-anchor.md
```

## Continuity Incidents

When `identityContinuityEnabled=true` and `continuityIncidentLoggingEnabled=true`, use these CLI commands:

```bash
openclaw engram continuity incidents --state open --limit 25
openclaw engram continuity incident-open --symptom "identity anchor missing in recovery response"
openclaw engram continuity incident-close --id incident-123 --fix-applied "restored merge guard" --verification-result "recovery prompt includes anchor"
```

Incident artifact location:

```text
<memoryDir>/identity/incidents/*.md
```

## Runbooks

- [PR Review Hardening Playbook](ops/pr-review-hardening-playbook.md)
- [Plugin Engineering Patterns](ops/plugin-engineering-patterns.md)
