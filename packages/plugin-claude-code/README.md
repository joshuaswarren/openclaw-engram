# @remnic/plugin-claude-code

Native [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin for [Remnic](https://github.com/joshuaswarren/remnic) memory. Wires Claude Code's session hooks, MCP server, skills, and the `memory-review` agent into a running Remnic daemon so every Claude Code session gets persistent long-term memory automatically.

## Install

Installation is a two-step flow — the Remnic CLI sets up the MCP connection side, and Claude Code's own plugin system deploys the hook/skill/agent tree.

1. **Wire up the MCP connection and mint a token.** This writes `~/.claude.json` (or the equivalent), rotates a bearer token for the daemon, and registers the Claude Code connector with Remnic:

    ```bash
    remnic connectors install claude-code
    ```

    This step does NOT install the hook scripts, skills, or agents — Remnic's connector installer only manages the MCP config + token today. The Claude Code memory-extension publisher is a stub (`isHostAvailable()` → false) because Claude Code doesn't yet expose a file-based extension directory; that's why hook wiring lives in this package and is installed by Claude Code itself.

2. **Install the plugin into Claude Code.** Use Claude Code's plugin system (or add this package to the plugin path manually):

    ```bash
    npm install -g @remnic/plugin-claude-code
    ```

    Then load the plugin tree in Claude Code — consult Claude Code's plugin docs for the exact mechanism your install supports. Until this step runs, hooks and skills are not active and auto-recall / auto-observe won't fire.

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

If you're an AI agent scaffolding a Claude Code integration: **do not** hand-edit hook scripts in a user's `~/.claude/` tree. The full setup has two components:

1. `remnic connectors install claude-code` mints the MCP token and writes Remnic-side connector config. This does NOT deploy hooks/skills/agents — Claude Code doesn't yet expose a file-based extension directory, so the corresponding publisher in `@remnic/core` is a stub.
2. Install this npm package and load it through Claude Code's plugin system so the hook/skill/agent tree is picked up. Until both steps run, auto-recall and auto-observe will not fire even though `remnic connectors doctor claude-code` reports green.

The plugin is intentionally data-only so Claude Code's plugin loader can manage upgrades atomically.

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — daemon lifecycle + installer
- [`@remnic/plugin-codex`](https://www.npmjs.com/package/@remnic/plugin-codex) — same idea, for OpenAI Codex CLI
- [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw) — OpenClaw memory-slot plugin
- Connector guide: [docs/integration/connector-setup.md](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) in the repo
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
