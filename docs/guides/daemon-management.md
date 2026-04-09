# Daemon Management

EMO (Engram Memory Orchestrator) runs as a background daemon that starts automatically on boot.

## Installation

```bash
engram daemon install
```

This:
1. Detects your platform (macOS or Linux)
2. Writes the appropriate service file
3. Enables auto-start on boot
4. Starts the daemon immediately

### macOS (launchd)

Service file: `~/Library/LaunchAgents/ai.engram.daemon.plist`

```bash
# Manual control
launchctl kickstart -k gui/$(id -u)/ai.engram.daemon    # restart
launchctl kill SIGTERM gui/$(id -u)/ai.engram.daemon     # stop
```

### Linux (systemd)

Service file: `~/.config/systemd/user/engram.service`

```bash
# Manual control
systemctl --user restart engram
systemctl --user stop engram
systemctl --user status engram
```

## CLI Commands

```bash
engram daemon install     # write service file + enable + start
engram daemon uninstall   # disable + remove service file
engram daemon start       # start now (without installing service)
engram daemon stop        # stop now
engram daemon restart     # restart
engram daemon status      # show running state, port, memory path
```

## Configuration

### Config File

`~/.config/engram/config.json` (or `ENGRAM_CONFIG_PATH` env var):

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4318,
    "maxBodyBytes": 10485760
  },
  "engram": {
    "memoryDir": "~/.engram/memory/",
    "openaiApiKey": "${OPENAI_API_KEY}",
    "searchBackend": "qmd",
    "recallBudgetChars": 64000
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_CONFIG_PATH` | `~/.config/engram/config.json` | Config file path |
| `ENGRAM_MEMORY_DIR` | `~/.engram/memory/` | Memory store directory |
| `REMNIC_HOST` | `127.0.0.1` | Bind address (`ENGRAM_HOST` also supported) |
| `REMNIC_PORT` | `4318` | Bind port (`ENGRAM_PORT` also supported) |
| `OPENAI_API_KEY` | — | Required for LLM extraction |

## Logs

```bash
# View daemon logs
tail -f ~/.engram/logs/daemon.log

# View hook-specific logs
tail -f ~/.engram/logs/engram-session-recall.log
tail -f ~/.engram/logs/engram-post-tool-observe.log
```

## Health Check

```bash
# CLI check
engram daemon status

# HTTP check
curl http://localhost:4318/engram/v1/health

# Full diagnostics
engram doctor
```

## Port Conflicts

If another process is using `:4318`:

```bash
# Find what's using the port
lsof -i :4318

# Use a different port
engram daemon stop
# Edit ~/.config/engram/config.json → "port": 4320
engram daemon start
```

Then update your plugin configs to use the new port.

## Security

- EMO binds to `127.0.0.1` by default (localhost only)
- To expose EMO on the network, set `"host": "0.0.0.0"` — but ensure token auth is configured
- Tokens stored in `~/.engram/tokens.json` with `0600` permissions
- See [auth-model.md](../architecture/auth-model.md) for token management

## Uninstall

```bash
engram daemon uninstall
```

This stops the daemon and removes the service file. Memory files at `~/.engram/memory/` are preserved.
