# @remnic/plugin-claude-code

Native [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin for [Remnic](https://github.com/joshuaswarren/remnic) memory. Wires Claude Code's session hooks, MCP server, skills, and the `memory-review` agent into a running Remnic daemon so every Claude Code session gets persistent long-term memory automatically.

## Install

```bash
# Recommended: the Remnic CLI installs + configures the plugin for you,
# mints an MCP token, and wires it into ~/.claude/.
remnic connectors install claude-code
```

Or install the package and point Claude Code at it manually:

```bash
npm install -g @remnic/plugin-claude-code
```

## What ships

The package is **data-only** (no JavaScript runtime) — it's a bundle of Claude Code configuration:

| File / dir | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest |
| `hooks/hooks.json` | `SessionStart`, `PostToolUse` (Write/Edit/MultiEdit), and `UserPromptSubmit` hook wiring |
| `hooks/bin/*.sh` | Small shell scripts that call the local Remnic daemon |
| `skills/` | `remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-status`, `remnic-entities`, `remnic-memory-workflow` |
| `agents/memory-review.md` | Subagent that audits + summarizes memory for long-running sessions |
| `.mcp.json` | MCP server config pointing Claude Code at `http://localhost:4318/mcp` |
| `settings.json` | Default Claude Code settings for the plugin |

## What you get at runtime

Once installed and a Remnic daemon is running (`remnic daemon start`):

- **Auto-recall** on `SessionStart` and on every `UserPromptSubmit` — relevant memories are injected into the session prompt before Claude Code's first turn and before each subsequent user turn.
- **Auto-observe** on `PostToolUse` for `Write`, `Edit`, and `MultiEdit` tools — new facts, decisions, and entities touched by file edits are buffered for extraction without the user lifting a finger.
- **Memory skills** — invoke `/remnic-recall`, `/remnic-search`, `/remnic-remember`, `/remnic-entities`, `/remnic-status` directly in Claude Code chats.
- **Cross-agent sharing** — the same memory store is shared with every other Remnic-connected agent (Codex, OpenClaw, Replit, Hermes, etc.), so what one agent learns is available to all.

## MCP setup

The plugin expects a Remnic daemon reachable at `http://localhost:4318/mcp` with a bearer token. `remnic connectors install claude-code` handles this automatically. If you're wiring it up by hand, the `.mcp.json` template is:

```json
{
  "mcpServers": {
    "remnic": {
      "type": "http",
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer {{REMNIC_TOKEN}}",
        "X-Engram-Client-Id": "claude-code"
      }
    }
  }
}
```

Replace `{{REMNIC_TOKEN}}` with a token minted via `remnic token generate <connector-id>`.

## Agent note

If you're an AI agent scaffolding a Claude Code integration: **do not** hand-edit hook scripts in a user's `~/.claude/` tree — run `remnic connectors install claude-code` instead, which keeps the installation in sync with this package and mints the right token. The plugin is intentionally data-only so the host `@remnic/cli` can manage upgrades atomically.

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — daemon lifecycle + installer
- [`@remnic/plugin-codex`](https://www.npmjs.com/package/@remnic/plugin-codex) — same idea, for OpenAI Codex CLI
- [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw) — OpenClaw memory-slot plugin
- Connector guide: [docs/integration/connector-setup.md](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) in the repo
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
