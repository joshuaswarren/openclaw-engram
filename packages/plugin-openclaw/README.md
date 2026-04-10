# @remnic/plugin-openclaw

OpenClaw plugin for Remnic memory. Thin adapter that connects the OpenClaw gateway to [`@remnic/core`](https://www.npmjs.com/package/@remnic/core).

Part of [Remnic](https://github.com/joshuaswarren/remnic), the universal memory layer for AI agents.

## Install

```bash
openclaw plugins install @remnic/plugin-openclaw --pin
```

Or ask your OpenClaw agent:

> Install the @remnic/plugin-openclaw plugin and configure it as my memory system.

## Configure

Add the plugin to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-engram"],
    "slots": { "memory": "openclaw-engram" }
  }
}
```

Then restart the gateway:

```bash
launchctl kickstart -k gui/501/ai.openclaw.gateway
```

## What it does

This plugin hooks into the OpenClaw gateway lifecycle:

- **`gateway_start`** -- initializes the Remnic memory engine
- **`before_agent_start`** -- injects relevant memories into the agent's context
- **`agent_end`** -- buffers the conversation turn for extraction
- **Tools** -- registers `memory_search`, `memory_stats`, and other agent tools
- **Commands** -- provides CLI commands for memory management

All memory processing uses [`@remnic/core`](https://www.npmjs.com/package/@remnic/core). Data stays on your local filesystem as plain markdown files.

## Standalone usage

If you're not using OpenClaw, use [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) or [`@remnic/server`](https://www.npmjs.com/package/@remnic/server) instead.

## License

MIT
