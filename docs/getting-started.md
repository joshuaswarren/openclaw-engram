# Getting Started

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) gateway running
- OpenAI API key (for extraction; retrieval-only mode works without one)
- [QMD](https://github.com/tobi/qmd) installed (recommended)

## Installation

### Option A: npm (recommended)

```bash
openclaw plugins install @joshuaswarren/openclaw-engram --pin
```

### Option B: Developer install (from Git)

```bash
git clone https://github.com/joshuaswarren/openclaw-engram.git \
  ~/.openclaw/extensions/openclaw-engram
cd ~/.openclaw/extensions/openclaw-engram
npm ci && npm run build
```

## Minimal Config

Add to `openclaw.json` under `plugins.entries.openclaw-engram.config`:

```jsonc
{
  "openaiApiKey": "${OPENAI_API_KEY}"
}
```

All other settings have sensible defaults. Reload the gateway:

```bash
kill -USR1 $(pgrep openclaw-gateway)
```

Verify startup:

```bash
grep '\[engram\]' ~/.openclaw/logs/gateway.log | tail -5
# Should see: [engram] started
```

## Set Up QMD (Recommended)

QMD provides hybrid BM25 + vector + reranking search. Without it, Engram falls back to semantic embedding search (using your OpenAI key when available) and then recency-ordered file reads.

Add to `~/.config/qmd/index.yml`:

```yaml
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]
```

Index the collection:

```bash
qmd update && qmd embed
```

Enable in your plugin config:

```jsonc
{
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram"
}
```

### Recommended QMD Patches (as of 2026-02-14)

Apply these locally to `~/.bun/install/global/node_modules/qmd/` until merged upstream:

1. **[PR #166](https://github.com/tobi/qmd/pull/166) — HTTP daemon crash fix**
   In `src/mcp.ts`, add `sessionIdGenerator: () => crypto.randomUUID()` to the `WebStandardStreamableHTTPServerTransport` constructor. Without this, the daemon crashes on the second MCP request.

2. **[PR #112](https://github.com/tobi/qmd/pull/112) — Model override env vars**
   Adds `QMD_EMBED_MODEL`, `QMD_RERANK_MODEL`, etc. Allows faster cold-start reranking with a smaller model.

3. **[PR #117](https://github.com/tobi/qmd/pull/117) — SQLite pathological join fix**
   Changes `JOIN` to `CROSS JOIN` in `searchFTS()`. Critical for large collections (90K+ files).

## Five-Minute Config

Enable the most impactful features incrementally:

```jsonc
{
  "openaiApiKey": "${OPENAI_API_KEY}",
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram",

  // v8.0: Recall Planner (enabled by default)
  "recallPlannerEnabled": true,

  // v8.0: Episode/Note dual store (opt-in)
  "episodeNoteModeEnabled": true,

  // v8.0: Memory Boxes (opt-in)
  "memoryBoxesEnabled": true,
  "traceWeaverEnabled": true
}
```

## Verify It Works

Start a conversation with OpenClaw. After a few turns, check:

```bash
# See extracted memories
ls ~/.openclaw/workspace/memory/local/facts/

# Search memories from CLI
openclaw engram search "your query"

# View stats
openclaw engram stats
```

## Config Override (Service Environments)

Override the config file path via environment variable:

```bash
OPENCLAW_ENGRAM_CONFIG_PATH=/absolute/path/to/openclaw.json
```

Fallback: `OPENCLAW_CONFIG_PATH`.

## Next Steps

- [Config Reference](config-reference.md) — full settings list
- [Operations](operations.md) — backups, exports, hourly summaries
- [Architecture Overview](architecture/overview.md) — how it all fits together
