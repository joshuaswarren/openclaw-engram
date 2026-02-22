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
launchctl kickstart -k gui/501/ai.openclaw.gateway

# Hot reload (does NOT fire gateway_start)
kill -USR1 $(pgrep openclaw-gateway)
```

## Logs

```bash
# Watch gateway logs for engram activity
grep '\[engram\]' ~/.openclaw/logs/gateway.log | tail -50 -f

# Slow query log (if slowLogEnabled)
cat ~/.openclaw/workspace/memory/local/state/slow.log
```

## Memory Store Maintenance

```bash
# Re-index all memories in QMD after manual changes
qmd update --collection openclaw-engram
qmd embed --collection openclaw-engram

# View dedup hash index size
wc -l ~/.openclaw/workspace/memory/local/state/fact-hashes.txt
```

## Runbooks

- [PR Review Hardening Playbook](ops/pr-review-hardening-playbook.md)
- [Plugin Engineering Patterns](ops/plugin-engineering-patterns.md)
