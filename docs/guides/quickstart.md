# Quickstart: Install Remnic in 5 Minutes

Remnic is a universal memory system for AI agents. Install it once, connect your tools, and all your agents share the same memory.

## Step 1: Install Remnic

```bash
npm install -g @remnic/cli
```

## Step 2: Start the Daemon

```bash
remnic daemon install
```

This starts the Remnic daemon (historically called EMO) and configures it to auto-start on boot.

Verify:

```bash
remnic daemon status
# ✓ Remnic server running on :4318
# ✓ Memory store: ~/.remnic/memory/
# ✓ Auto-start: enabled
```

## Step 3: Connect Your Tools

Install plugins for the AI tools you use:

```bash
# Connect Claude Code (hooks + MCP + skills)
remnic connectors install claude-code

# Connect Codex CLI (hooks + MCP + skills)
remnic connectors install codex-cli

# Connect Hermes Agent (MemoryProvider + tools)
remnic connectors install hermes

# Connect Replit Agent (MCP only)
remnic connectors install replit
```

Each command generates a dedicated auth token and installs the native plugin for that platform.

## Step 4: Verify

```bash
remnic connectors doctor
# ✓ claude-code: connected, 44 tools available
# ✓ codex-cli: connected, 44 tools available
# ✓ hermes: connected, MemoryProvider active
# ✓ replit: token generated (configure in Integrations pane)
```

## Step 5: Use It

Just use your AI tools normally. Remnic works automatically:

- **Start a session** → Remnic recalls your preferences and project context
- **Type a prompt** → Remnic injects relevant memories
- **Edit files** → Remnic observes and learns patterns
- **Switch tools** → memories carry over instantly

### Try it

In Claude Code:
```
> /engram:remember I prefer functional programming patterns over OOP
> /engram:recall programming preferences
```

The slash commands still use the legacy `/engram:*` names during the v1.x compatibility window. The product and CLI are now `remnic`.

Then open Codex CLI and start a new session — it already knows your preference.

### Get a daily briefing

Once you have memories flowing in, generate a focused summary of what changed recently:

```bash
remnic briefing                          # yesterday, markdown, no save
remnic briefing --since 3d               # last 72 hours
remnic briefing --focus project:alpha    # scoped to one project
remnic briefing --format json --save     # save a dated JSON file
```

The briefing cross-references active entities, recent facts, and open commitments. If `OPENAI_API_KEY` is set, it also appends a short list of suggested follow-ups via the Responses API. See [Daily Briefing](./daily-briefing.md) for the full guide.

## Already Using OpenClaw?

If you're an existing OpenClaw user:

```bash
remnic connectors install openclaw
```

This upgrades OEO to expose `:4318` so other agents can share the same memory store OpenClaw uses. Your existing memories are untouched.

## Next Steps

- [Daemon management](./daemon-management.md) — configure auto-start, logs, ports
- [Plugin docs](../plugins/) — detailed guides per platform
- [Architecture](../architecture/emo-oeo-split.md) — how it works under the hood
