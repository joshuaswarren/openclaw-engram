# OpenClaw Plugin (OEO)

The OpenClaw Engram Orchestrator (OEO) is a memory-slot plugin that bridges OpenClaw to the Engram memory engine.

## Installation

OEO is the original Engram integration. If you're already using Engram with OpenClaw, you have it.

```bash
openclaw plugins install openclaw-engram
```

Or via the Engram CLI:

```bash
engram connectors install openclaw
```

## What It Does

### Memory Slot Integration

OEO registers with OpenClaw's exclusive memory slot:

| API | What It Does |
|-----|-------------|
| `registerMemoryPromptSection(builder)` | Injects recalled memories into every agent prompt |
| `registerMemoryFlushPlan(resolver)` | Automatically persists memories after conversations |
| `registerMemoryRuntime(runtime)` | Provides the full memory runtime to OpenClaw |

### 43+ Tools

All Engram tools are registered with OpenClaw's tool system — recall, observe, governance, work tracking, shared context, identity continuity, etc.

### HTTP Server for External Agents

**Even in embedded mode**, OEO starts an HTTP server on `:4318`. This lets Claude Code, Codex, Hermes, and Replit connect to the same memory store OpenClaw uses.

## Modes

See [embedded-vs-delegate.md](../architecture/embedded-vs-delegate.md) for details.

### Embedded (Default)

OEO runs the Orchestrator in-process + exposes `:4318`.

### Delegate

OEO proxies to a running EMO daemon. Set in config:

```json
{ "engram": { "mode": "delegate" } }
```

## Memory Store Location

OEO stores memories at `~/.openclaw/workspace/memory/local/` — the standard OpenClaw path. This ensures:

- Ops Dashboard memory views work
- Conductor reads memory for approval context
- Cron jobs (morning report, self-improvement) access memory
- Agents share context through the memory directory

## Upgrade Guide

If you're upgrading from the monolithic Engram plugin to the new EMO/OEO architecture:

1. The npm package name is unchanged: `openclaw-engram`
2. Memory files stay at `~/.openclaw/workspace/memory/local/` — no migration needed
3. All OpenClaw tools keep working — same names, same behavior
4. **New:** `:4318` is now exposed for external agents (Claude Code, Codex, etc.)

To connect other agents after upgrading:

```bash
engram connectors install claude-code   # now shares memory with OpenClaw
```

## Troubleshooting

### Port 4318 already in use

Another EMO instance or service is on `:4318`. OEO auto-switches to delegate mode.

To resolve: stop the conflicting process, or set `mode: "delegate"` to use the existing daemon.

### Memory not appearing in OpenClaw

Check the plugin is loaded:

```bash
tail -20 ~/.openclaw/logs/gateway.log | grep -i engram
```
