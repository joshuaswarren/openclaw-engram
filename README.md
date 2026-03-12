# Engram

**Persistent memory for AI coding agents.** Your agents forget everything between sessions — Engram fixes that.

Engram gives AI agents long-term memory that survives across conversations. Decisions, preferences, debugging history, architecture context, project conventions — everything your agent learns persists and resurfaces exactly when it's needed.

[![npm version](https://img.shields.io/npm/v/@joshuaswarren/openclaw-engram)](https://www.npmjs.com/package/@joshuaswarren/openclaw-engram)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## The Problem

Every AI coding session starts from zero. Your agent doesn't know your project conventions, your architecture decisions, the bugs you already debugged, or even your name. You re-explain the same context over and over — and the agent still makes the same mistakes.

## The Solution

Engram watches your agent conversations, extracts durable knowledge, and injects the right memories back at the start of every session. It works with **[OpenClaw](https://github.com/openclaw/openclaw)** as a native plugin and with **[Codex CLI](https://github.com/openai/codex)** via MCP — with more integrations coming.

| Without Engram | With Engram |
|---|---|
| Re-explain project conventions every session | Agent recalls coding standards and patterns automatically |
| Repeat architecture context for every task | Entity knowledge surfaces schemas, API contracts, and module boundaries |
| Lose debugging context between sessions | Past root causes and dead ends are recalled — no repeated work |
| Manually restate tool/linter/workflow preferences | Preferences persist across sessions and projects |
| Context-switching tax when resuming work | Session-start recall brings you back to speed instantly |

## Quick Start

### With OpenClaw (native plugin)

```bash
openclaw plugins install @joshuaswarren/openclaw-engram --pin
```

Add to `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-engram"],
    "slots": { "memory": "openclaw-engram" },
    "entries": {
      "openclaw-engram": {
        "enabled": true,
        "config": {
          "openaiApiKey": "${OPENAI_API_KEY}"
        }
      }
    }
  }
}
```

Restart the gateway and start a conversation — Engram begins learning immediately.

### With Codex CLI (via MCP)

Start the Engram HTTP server:

```bash
# Generate a token
export OPENCLAW_ENGRAM_ACCESS_TOKEN="$(openssl rand -base64 32)"

# Start the server
openclaw engram access http-serve \
  --host 127.0.0.1 \
  --port 4318 \
  --token "$OPENCLAW_ENGRAM_ACCESS_TOKEN"
```

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.engram]
url = "http://127.0.0.1:4318/mcp"
bearer_token_env_var = "OPENCLAW_ENGRAM_ACCESS_TOKEN"
```

That's it. Codex now has access to Engram's recall, store, and entity tools. See the [full Codex integration guide](docs/guides/codex-cli.md) for session-start hooks and cross-machine setup.

### With Any MCP Client (Claude Code, etc.)

Run the stdio MCP server:

```bash
openclaw engram access mcp-serve
```

Point your MCP client's command at `openclaw engram access mcp-serve`. The server exposes the same tools as the HTTP endpoint.

## How It Works

Engram operates in three phases:

```
 Recall    → Before each conversation, inject relevant memories into context
 Buffer    → After each turn, accumulate content until a trigger fires
 Extract   → Periodically, extract structured memories using an LLM
```

Memories are stored as plain markdown files with YAML frontmatter — fully portable, git-friendly, no database required:

```yaml
---
id: decision-1738789200000-a1b2
category: decision
confidence: 0.92
tags: ["architecture", "search"]
---
Decided to use the port/adapter pattern for search backends
so alternative engines can replace QMD without changing core logic.
```

Memory categories include: `fact`, `decision`, `preference`, `correction`, `relationship`, `principle`, `commitment`, `moment`, `skill`, `rule`, and more.

## Why Engram?

### Local-first, zero lock-in

All memory lives on your filesystem as markdown. No cloud dependency, no proprietary formats. Back it up with git, rsync, or Time Machine. Move it between machines with a folder copy.

### Smart recall, not keyword search

Engram uses hybrid search (BM25 + vector + reranking via [QMD](https://github.com/tobilu/qmd)) to find semantically relevant memories. It doesn't just match keywords — it understands what you're working on and surfaces the right context.

### Progressive complexity

Start with zero config. Enable features as your needs grow:

| Level | What You Get |
|-------|-------------|
| **Defaults** | Automatic extraction, recall injection, entity tracking, lifecycle management |
| **+ Search tuning** | Choose from 6 search backends (QMD, Orama, LanceDB, Meilisearch, remote, noop) |
| **+ Capture control** | `implicit`, `explicit`, or `hybrid` capture modes for memory write policy |
| **+ Memory OS** | Memory boxes, graph reasoning, compounding, shared context, identity continuity |
| **+ Advanced** | Trust zones, causal trajectories, harmonic retrieval, evaluation harness, poisoning defense |

Use a preset to jump to a recommended level: `conservative`, `balanced`, `research-max`, or `local-llm-heavy`.

### Works with your tools

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Native plugin with automatic extraction and recall injection
- **[Codex CLI](https://github.com/openai/codex)** — MCP-over-HTTP with session-start hooks for automatic recall
- **Any MCP client** — stdio or HTTP transport, 8 tools available
- **Scripts & automation** — Authenticated REST API for custom integrations
- **Local LLMs** — Run extraction and reranking with local models (Ollama, LM Studio, etc.)

### Built for production

- **672 tests** with CI enforcement
- **Evaluation harness** with benchmark packs, shadow recall recording, and CI delta gates
- **Governance system** with review queues, shadow/apply modes, and reversible transitions
- **Namespace isolation** for multi-agent deployments
- **Rate limiting** on write paths with idempotency support

## Features

### Core

- **Automatic memory extraction** — Facts, decisions, preferences, corrections extracted from conversations
- **Recall injection** — Relevant memories injected before each agent turn
- **Entity tracking** — People, projects, tools, companies tracked as structured entities
- **Lifecycle management** — Memories age through active, validated, stale, archived states
- **Episode/Note model** — Memories classified as time-specific events or stable beliefs

### Search Backends

| Backend | Type | Best For |
|---------|------|----------|
| **QMD** (default) | Hybrid BM25+vector+reranking | Best recall quality |
| **Orama** | Embedded, pure JS | Zero native deps |
| **LanceDB** | Embedded, native Arrow | Large collections |
| **Meilisearch** | Server-based | Shared search |
| **Remote** | HTTP REST | Custom services |
| **Noop** | No-op | Extraction only |

See the [Search Backends Guide](docs/search-backends.md) or [write your own](docs/writing-a-search-backend.md).

### Memory OS (opt-in)

These capabilities can be enabled progressively:

- **Memory Boxes** — Groups related memories into topic-windowed episodes
- **Graph Recall** — Entity-relationship graph for causal and timeline queries
- **Compounding** — Weekly synthesis surfaces patterns and recurring mistakes
- **Shared Context** — Cross-agent memory sharing for multi-agent setups
- **Identity Continuity** — Consistent agent personality across sessions
- **Hot/Cold Tiering** — Automatic migration of aging memories to cold storage
- **Native Knowledge** — Search curated markdown (workspace docs, Obsidian vaults) without extracting into memory
- **Behavior Loop Tuning** — Runtime self-tuning of extraction and recall parameters

### Advanced (opt-in)

- **Objective-State Recall** — Surfaces file/process/tool state snapshots alongside semantic memory
- **Causal Trajectories** — Typed `goal -> action -> observation -> outcome` chains
- **Trust Zones** — Quarantine/working/trusted tiers with promotion rules and poisoning defense
- **Harmonic Retrieval** — Blends abstraction nodes with cue-anchor matches
- **Verified Recall** — Only surfaces memory boxes whose source memories still verify
- **Semantic Rule Promotion** — Promotes `IF ... THEN` rules from verified episodes
- **Creation Memory** — Work-product ledger tracking agent outputs
- **Commitment Lifecycle** — Tracks promises, deadlines, and obligations
- **Resume Bundles** — Crash-recovery context for interrupted sessions
- **Utility Learning** — Learns promotion/ranking weights from downstream outcomes

See [Enable All Features](docs/enable-all-v8.md) for a full-feature config profile.

## Access Layer

Engram exposes one shared service layer through multiple transports:

### HTTP API

```bash
openclaw engram access http-serve --token "$OPENCLAW_ENGRAM_ACCESS_TOKEN"
```

Key endpoints: `GET /engram/v1/health`, `POST /engram/v1/recall`, `POST /engram/v1/memories`, `GET /engram/v1/entities/:name`, and more. Full reference in [API docs](docs/api.md).

The HTTP server also hosts a lightweight operator UI at `http://127.0.0.1:4318/engram/ui/` for memory browsing, recall inspection, governance review, and entity exploration.

### MCP Tools

Available via both stdio and HTTP transports:

| Tool | Purpose |
|------|---------|
| `engram.recall` | Retrieve relevant memories for a query |
| `engram.recall_explain` | Debug the last recall |
| `engram.memory_get` | Fetch a specific memory by ID |
| `engram.memory_timeline` | View a memory's lifecycle history |
| `engram.memory_store` | Store a new memory |
| `engram.suggestion_submit` | Queue a memory for review |
| `engram.entity_get` | Look up a known entity |
| `engram.review_queue_list` | View the governance review queue |

### MCP over HTTP

The HTTP server exposes an MCP JSON-RPC endpoint at `POST /mcp`, allowing remote MCP clients to use Engram tools over HTTP:

```bash
openclaw engram access http-serve --host 0.0.0.0 --port 4318 --token "$TOKEN"
```

For namespace-enabled deployments, pass `--principal <name>` where `<name>` matches a `writePrincipals` entry for your target namespace. Deployments with `namespacesEnabled: false` (the default) do not need `--principal`.

## CLI Reference

```bash
# Setup & diagnostics
openclaw engram setup              # Guided first-run setup
openclaw engram doctor             # Health diagnostics with remediation hints
openclaw engram config-review      # Config tuning recommendations
openclaw engram stats              # Memory counts, search status
openclaw engram inventory          # Full storage and namespace inventory

# Search & recall
openclaw engram search "query"     # Search memories from CLI
openclaw engram harmonic-search "query"  # Preview harmonic retrieval matches

# Governance
openclaw engram governance-run --mode shadow  # Preview governance transitions
openclaw engram governance-run --mode apply   # Apply reversible transitions
openclaw engram review-disposition <id> --status rejected  # Operator review

# Benchmarking
openclaw engram benchmark recall   # Benchmark status and validation
openclaw engram benchmark-ci-gate  # CI gate for regressions

# Access layer
openclaw engram access http-serve --token "$TOKEN"  # Start HTTP API
openclaw engram access mcp-serve   # Start stdio MCP server
```

See the [full CLI reference](docs/api.md#cli-commands) for all commands.

## Configuration

All settings live in `openclaw.json` under `plugins.entries.openclaw-engram.config`.

Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env)` | OpenAI API key (optional with local LLM) |
| `model` | `gpt-5.2` | LLM for extraction |
| `searchBackend` | `"qmd"` | Search engine to use |
| `captureMode` | `implicit` | Memory write policy |
| `recallBudgetChars` | `maxMemoryTokens * 4` | Recall budget (default ~8K chars; set 64K+ for large-context models) |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage root |
| `memoryOsPreset` | unset | Quick config: `conservative`, `balanced`, `research-max`, `local-llm-heavy` |
| `localLlmEnabled` | `false` | Use local LLM for extraction |

Full reference: [docs/config-reference.md](docs/config-reference.md)

## Documentation

- [Getting Started](docs/getting-started.md) — Installation, setup, first-run verification
- [Config Reference](docs/config-reference.md) — Every setting with defaults
- [Architecture Overview](docs/architecture/overview.md) — System design and storage layout
- [Retrieval Pipeline](docs/architecture/retrieval-pipeline.md) — How recall works
- [Memory Lifecycle](docs/architecture/memory-lifecycle.md) — Write, consolidation, expiry
- [Search Backends](docs/search-backends.md) — Choosing and configuring search engines
- [Writing a Search Backend](docs/writing-a-search-backend.md) — Build your own adapter
- [API Reference](docs/api.md) — HTTP, MCP, and CLI documentation
- [Codex CLI Integration](docs/guides/codex-cli.md) — Setup Engram with OpenAI's Codex
- [Local LLM Guide](docs/guides/local-llm.md) — Local-first extraction and reranking
- [Cost Control Guide](docs/guides/cost-control.md) — Budget mappings and presets
- [Namespaces](docs/namespaces.md) — Multi-agent memory isolation
- [Shared Context](docs/shared-context.md) — Cross-agent intelligence
- [Identity Continuity](docs/identity-continuity.md) — Consistent agent personality
- [Graph Reasoning](docs/architecture/graph-reasoning.md) — Opt-in graph traversal
- [Evaluation Harness](docs/evaluation-harness.md) — Benchmarks and CI delta gates
- [Operations](docs/operations.md) — Backup, export, maintenance
- [Enable All Features](docs/enable-all-v8.md) — Full-feature config profile
- [Migration Guide](docs/guides/migrations.md) — Upgrading from older versions

## Developer Install

```bash
git clone https://github.com/joshuaswarren/openclaw-engram.git \
  ~/.openclaw/extensions/openclaw-engram
cd ~/.openclaw/extensions/openclaw-engram
npm ci && npm run build
```

Run tests:

```bash
npm test              # Full suite (672 tests)
npm run check-types   # TypeScript type checking
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests for new functionality
4. Ensure `npm test` and `npm run check-types` pass
5. Submit a pull request

## License

[MIT](LICENSE)
