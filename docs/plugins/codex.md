# Codex CLI Plugin

Native Remnic plugin for OpenAI Codex CLI. Provides automatic memory recall, observation, and session-end learning capture.

## Installation

```bash
remnic connectors install codex-cli
```

This:
1. Starts the Remnic daemon if not running
2. Generates a dedicated auth token
3. Installs the plugin to `~/.codex/plugins/`
4. Enables hooks (`[features] codex_hooks = true` in `~/.codex/config.toml`)
5. Configures MCP server pointing to Remnic
6. Runs a health check

## What It Does

### Automatic Memory (via hooks)

| Hook | When | What Happens |
|------|------|-------------|
| `SessionStart` | Session begins | Recalls project context + user preferences |
| `UserPromptSubmit` | Every user message | Recalls memories relevant to the prompt |
| `PostToolUse` | After Bash execution | Observes command results and file changes |
| `Stop` | Session ends | Flushes session learnings to EMO |

### Explicit Skills

| Skill | Description |
|-------|-------------|
| `memory-workflow` | Instructions for memory-aware coding workflows |

### MCP Tools

All 44 Remnic MCP tools are available via the `.mcp.json` configuration. The legacy `engram.*` aliases remain available during v1.x.

## How It Differs from Claude Code Plugin

- **Stop hook:** Codex has a `Stop` event that fires when the agent completes its turn. The plugin uses this to flush any remaining observations and store session learnings — ensuring nothing is lost even if the session ends abruptly.
- **PostToolUse matcher:** Matches `Bash` (Codex's primary tool) instead of `Write|Edit|MultiEdit`.
- **Hooks feature flag:** Codex hooks require `[features] codex_hooks = true` — the installer sets this automatically.
- **Config format:** TOML (`~/.codex/config.toml`) instead of JSON.

## Configuration

Token is read from `~/.remnic/tokens.json`, with `~/.engram/tokens.json` still accepted as a migration fallback. Server defaults to `127.0.0.1:4318`.

## Troubleshooting

Same as Claude Code plugin — see [claude-code.md](./claude-code.md#troubleshooting).

Additional Codex-specific issue:

### Hooks not firing

Verify hooks are enabled:

```bash
grep codex_hooks ~/.codex/config.toml
# Should show: codex_hooks = true
```

## Uninstall

```bash
remnic connectors remove codex-cli
```
