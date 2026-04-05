# Quickstart: Install Engram in 5 Minutes

Engram is a universal memory system for AI agents. Install it once, connect your tools, and all your agents share the same memory.

## Step 1: Install Engram

```bash
npm install -g engram
```

## Step 2: Start the Daemon

```bash
engram daemon install
```

This starts EMO (Engram Memory Orchestrator) and configures it to auto-start on boot.

Verify:

```bash
engram daemon status
# ✓ EMO running on :4318
# ✓ Memory store: ~/.engram/memory/
# ✓ Auto-start: enabled
```

## Step 3: Connect Your Tools

Install plugins for the AI tools you use:

```bash
# Connect Claude Code (hooks + MCP + skills)
engram connectors install claude-code

# Connect Codex CLI (hooks + MCP + skills)
engram connectors install codex

# Connect Hermes Agent (MemoryProvider + tools)
engram connectors install hermes

# Connect Replit Agent (MCP only)
engram connectors install replit
```

Each command generates a dedicated auth token and installs the native plugin for that platform.

## Step 4: Verify

```bash
engram connectors doctor
# ✓ claude-code: connected, 44 tools available
# ✓ codex: connected, 44 tools available
# ✓ hermes: connected, MemoryProvider active
# ✓ replit: token generated (configure in Integrations pane)
```

## Step 5: Use It

Just use your AI tools normally. Engram works automatically:

- **Start a session** → Engram recalls your preferences and project context
- **Type a prompt** → Engram injects relevant memories
- **Edit files** → Engram observes and learns patterns
- **Switch tools** → memories carry over instantly

### Try it

In Claude Code:
```
> /engram:remember I prefer functional programming patterns over OOP
> /engram:recall programming preferences
```

Then open Codex CLI and start a new session — it already knows your preference.

## Already Using OpenClaw?

If you're an existing OpenClaw user:

```bash
engram connectors install openclaw
```

This upgrades OEO to expose `:4318` so other agents can share the same memory store OpenClaw uses. Your existing memories are untouched.

## Next Steps

- [Daemon management](./daemon-management.md) — configure auto-start, logs, ports
- [Plugin docs](../plugins/) — detailed guides per platform
- [Architecture](../architecture/emo-oeo-split.md) — how it works under the hood
