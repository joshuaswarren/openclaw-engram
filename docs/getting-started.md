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

All other settings have sensible defaults. Config changes require a full gateway restart (hot reload via `SIGUSR1` does not fire `gateway_start`):

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
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
openclaw engram setup --json
openclaw engram config-review --json
openclaw engram doctor --json
openclaw engram inventory --json

# See extracted memories
ls ~/.openclaw/workspace/memory/local/facts/

# Search memories from CLI
openclaw engram search "your query"
```

## Config Override (Service Environments)

Override the config file path via environment variable:

```bash
OPENCLAW_ENGRAM_CONFIG_PATH=/absolute/path/to/openclaw.json
```

Fallback: `OPENCLAW_CONFIG_PATH`.

## Alternative Search Backends (v9.0)

QMD provides the highest quality retrieval, but Engram v9 supports five other backends. To use an alternative, set `searchBackend` in your config:

```jsonc
{
  "searchBackend": "orama"   // or "lancedb", "meilisearch", "remote", "noop"
}
```

Orama requires zero setup — no external server, no native dependencies. Just set the config and restart.

See [Search Backends](search-backends.md) for a full comparison and configuration guide.

## Next Steps

- [Search Backends](search-backends.md) — choose and configure your search engine
- [Enable All Features](enable-all-v8.md) — explicit full-profile config for all feature families
- [Config Reference](config-reference.md) — full settings list with defaults and recommended values
- [Operations](operations.md) — backups, exports, hourly summaries
- [Architecture Overview](architecture/overview.md) — how it all fits together
- [Writing a Search Backend](writing-a-search-backend.md) — implement your own adapter
