# Claude Code Plugin

Native Remnic plugin for Claude Code. Provides automatic memory recall on every prompt, observation of file changes, and explicit memory skills.

## Installation

```bash
remnic connectors install claude-code
```

This:
1. Starts the Remnic daemon if not running (with auto-start on boot)
2. Generates a dedicated auth token
3. Installs the plugin to Claude Code's plugin directory
4. Configures MCP server pointing to `http://localhost:4318/mcp`
5. Runs a health check

Restart Claude Code after installation.

## What It Does

### Automatic Memory (via hooks)

Memory is **mandatory** — the plugin enforces it via lifecycle hooks. You don't need to do anything.

| Hook | When | What Happens |
|------|------|-------------|
| `SessionStart` | Session begins | Recalls project context + user preferences. Injects as `additionalContext`. |
| `UserPromptSubmit` | Every user message | Recalls memories relevant to your prompt. Injects as `additionalContext`. Skips prompts < 4 words. |
| `PostToolUse` | After Write/Edit/MultiEdit | Observes file changes in background. EMO extracts learnings asynchronously. |

### Explicit Skills

| Skill | Description |
|-------|-------------|
| `/engram:remember <text>` | Store a memory explicitly ("I prefer tabs over spaces") |
| `/engram:recall <query>` | Search memories ("what do I know about auth?") |
| `/engram:search <query>` | Semantic search across all memories |
| `/engram:entities` | List all tracked entities (people, projects, tools) |
| `/engram:status` | Show Remnic connection status and memory stats |

### MCP Tools

All 44 Remnic MCP tools are available for advanced operations: governance, work tracking, shared context, identity continuity, etc. The slash commands still use the legacy `/engram:*` names during the v1.x compatibility window.

## How Memory Injection Works

### SessionStart

When you start a Claude Code session, the hook:

1. Reads the session ID and working directory from stdin
2. Calls `POST /engram/v1/recall` with a project-scoped query
3. Receives memories (preferences, decisions, patterns, context)
4. Returns them as `additionalContext` in the hook response

Claude Code then includes this context before processing your first message.

### UserPromptSubmit

When you type a message, the hook:

1. Reads your prompt text
2. Skips if < 4 words (not worth a round-trip)
3. Calls `POST /engram/v1/recall` with your prompt as the query (minimal mode, 20s timeout)
4. Returns relevant memories as `additionalContext`
5. If recall fails or times out, continues without memory (graceful degradation)

### PostToolUse

When Claude Code writes or edits a file, the hook:

1. Reads the tool output (file path, content)
2. Calls `POST /engram/v1/observe` in the background (non-blocking)
3. EMO extracts learnings asynchronously (what changed, why, patterns)

## Configuration

The plugin reads its token from `~/.remnic/tokens.json`, with `~/.engram/tokens.json` still accepted as a migration fallback, and connects to the Remnic daemon at `127.0.0.1:4318`.

Override the server address:

```bash
export REMNIC_HOST=192.168.1.100
export REMNIC_PORT=4318
```

## Troubleshooting

### "Remnic: server unreachable"

The Remnic daemon isn't running. Fix:

```bash
remnic daemon status     # check
remnic daemon install    # install + start
```

### Slow recall on prompts

The `UserPromptSubmit` hook has a 20s timeout. If recall is consistently slow:

```bash
remnic doctor            # check search backend health
```

### No memories being stored

Check that the `PostToolUse` hook is firing:

```bash
tail -f ~/.remnic/logs/engram-post-tool-observe.log
```

### Plugin not loading

```bash
remnic connectors doctor claude-code
```

## Uninstall

```bash
remnic connectors remove claude-code
```
