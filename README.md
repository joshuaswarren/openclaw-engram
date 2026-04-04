# Engram

**Persistent, private memory for AI agents.** Your agents forget everything between sessions — Engram fixes that.

Engram gives AI agents long-term memory that survives across conversations. Decisions, preferences, project context, personal details, past mistakes — everything your agent learns persists and resurfaces exactly when it's needed. All data stays on your machine as plain markdown files. No cloud services, no subscriptions, no sharing your data with third parties.

[![npm version](https://img.shields.io/npm/v/@joshuaswarren/openclaw-engram)](https://www.npmjs.com/package/@joshuaswarren/openclaw-engram)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink)](https://github.com/sponsors/joshuaswarren)

## The Problem

Every AI agent session starts from zero. Your agent doesn't know your name, your projects, the decisions you've already made, or the bugs you already debugged. Whether it's a personal assistant, a coding agent, a research agent, or a multi-agent team — they all forget everything between conversations. You re-explain the same context over and over, and your agents still make the same mistakes.

OpenClaw's built-in memory works for simple cases, but it doesn't scale. It lacks semantic search, lifecycle management, entity tracking, and governance. Third-party memory services exist, but they cost money and require sending your private data to someone else's servers.

## The Solution

Engram is an open-source, local-first memory system that replaces OpenClaw's default memory with something much more capable — while keeping everything on your machine. It watches your agent conversations, extracts durable knowledge, and injects the right memories back at the start of every session. Use OpenAI or a **local LLM** (Ollama, LM Studio, etc.) for extraction — your choice.

It works as a native **[OpenClaw](https://github.com/openclaw/openclaw)** plugin, with **[Codex CLI](https://github.com/openai/codex)** via MCP, and with any other MCP-compatible client — with more integrations coming.

| Without Engram | With Engram |
|---|---|
| Re-explain who you are and what you're working on | Agent recalls your identity, projects, and preferences automatically |
| Repeat context for every task | Entity knowledge surfaces people, projects, tools, and relationships on demand |
| Lose debugging and research context between sessions | Past root causes, dead ends, and findings are recalled — no repeated work |
| Manually restate preferences every session | Preferences persist across sessions, agents, and projects |
| Context-switching tax when resuming work | Session-start recall brings you back to speed instantly |
| Default OpenClaw memory doesn't scale | Hybrid search, lifecycle management, namespaces, and governance |
| Third-party memory services cost money and share your data | Everything stays local — your filesystem, your rules |

## Installation

### Option 1: Install from the CLI

```bash
openclaw plugins install @joshuaswarren/openclaw-engram --pin
```

### Option 2: Ask your OpenClaw agent to install it

Tell any OpenClaw agent:

> Install the openclaw-engram plugin and configure it as my memory system.

Your agent will run the install command, update `openclaw.json`, and restart the gateway for you.

### Option 3: Developer install from source

```bash
git clone https://github.com/joshuaswarren/openclaw-engram.git \
  ~/.openclaw/extensions/openclaw-engram
cd ~/.openclaw/extensions/openclaw-engram
npm ci && npm run build
```

### Option 4: Standalone (no OpenClaw)

Install the package globally and use the standalone CLI:

```bash
npm install -g @joshuaswarren/openclaw-engram
engram init                      # Create engram.config.json
export OPENAI_API_KEY=sk-...
export ENGRAM_AUTH_TOKEN=$(openssl rand -hex 32)
engram daemon start              # Start background server
engram status                    # Verify it's running
engram query "hello" --explain   # Test query with tier breakdown
```

The standalone CLI provides 15+ commands for memory management, project onboarding, curation, diff-aware sync, dedup, connectors, spaces, and benchmarks -- all without requiring OpenClaw. See the [Platform Migration Guide](docs/guides/platform-migration.md) for the full command reference.

### Configure

After installation, add Engram to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-engram"],
    "slots": { "memory": "openclaw-engram" },
    "entries": {
      "openclaw-engram": {
        "enabled": true,
        "config": {
          // Option 1: Use OpenAI for extraction:
          "openaiApiKey": "${OPENAI_API_KEY}"

          // Option 2: Use Engram's local LLM path (plugin mode only; no API key needed):
          // "localLlmEnabled": true,
          // "localLlmUrl": "http://localhost:1234/v1",
          // "localLlmModel": "qwen2.5-32b-instruct"

          // Option 3: Use the gateway model chain (primary path in gateway mode):
          // "modelSource": "gateway",
          // "gatewayAgentId": "engram-llm",
          // "fastGatewayAgentId": "engram-llm-fast"
        }
      }
    }
  }
}
```

> **Gateway model source:** When `modelSource` is `"gateway"`, Engram routes all LLM calls (extraction, consolidation, reranking) through an OpenClaw agent persona's model chain instead of its own config. Extraction starts on the `gatewayAgentId` chain directly in this mode; `localLlm*` settings do not control primary extraction order. Define agent personas in `openclaw.json → agents.list[]` with a `primary` model and `fallbacks[]` array — Engram tries each in order until one succeeds. This lets you build multi-provider fallback chains like Fireworks → local LLM → cloud OpenAI. See the [Gateway Model Source](docs/config-reference.md#gateway-model-source) guide for full setup.

Restart the gateway:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway   # macOS
# or: systemctl restart openclaw-gateway                    # Linux
```

Start a conversation — Engram begins learning immediately.

> **Note:** This shows only the minimal config. Engram has 60+ configuration options for search backends, capture modes, memory OS features, and more. See the [full config reference](docs/config-reference.md) for every setting.

### Verify installation

```bash
openclaw engram setup --json         # Validates config, scaffolds directories
openclaw engram doctor --json        # Health diagnostics with remediation hints
openclaw engram config-review --json # Opinionated config tuning recommendations
```

## Using Engram with Codex CLI

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

That's it. Codex now has access to Engram's recall, store, and entity tools. See the [full Codex integration guide](docs/guides/codex-cli.md) for session-start hooks, cross-machine setup, and automatic recall at session start.

## Using Engram with Any MCP Client

Run the stdio MCP server:

```bash
openclaw engram access mcp-serve
```

Point your MCP client's command at `openclaw engram access mcp-serve`. Works with Claude Code, and any other MCP-compatible client. The server exposes the same tools as the HTTP endpoint.

**Claude Code (MCP over HTTP):** Start the Engram HTTP server, then add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${ENGRAM_TOKEN}"
      }
    }
  }
}
```

See the [Standalone Server Guide](docs/guides/standalone-server.md) for multi-tenant setups and connecting multiple agent harnesses.

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

## Architecture

Starting with v9.1.36, Engram is organized as a monorepo with five packages:

```
                    ┌─────────────────┐
                    │  @engram/core   │
                    │  (engine)       │
                    └────────┬────────┘
                             │
               ┌─────────────┼─────────────┐
               │             │             │
        ┌──────┴──────┐ ┌───┴────┐ ┌──────┴──────────┐
        │ @engram/cli │ │@engram/│ │ @engram/         │
        │ (CLI binary)│ │server  │ │ hermes-provider  │
        └─────────────┘ └────────┘ └─────────────────┘
                             │
                      ┌──────┴──────┐
                      │ @engram/    │
                      │ bench       │
                      └─────────────┘
```

| Package | Description |
|---------|-------------|
| `@engram/core` | Framework-agnostic engine with zero OpenClaw imports. Re-exports orchestrator, config, storage, search, extraction, graph, and trust zones. |
| `@engram/cli` | Standalone CLI binary with 15+ commands for memory management, project onboarding, curation, sync, dedup, connectors, spaces, and benchmarks. |
| `@engram/server` | Standalone HTTP/MCP server wrapping the existing access layer. Run independently or as a daemon. |
| `@engram/bench` | Latency ladder benchmarks with tier breakdowns, saved baselines, and CI regression gates. |
| `@engram/hermes-provider` | Lightweight HTTP client for connecting to remote Engram instances. Works with any TypeScript project. |

The npm package `@joshuaswarren/openclaw-engram` continues to work as the primary distribution channel for OpenClaw users. The `@engram/*` packages are for standalone use or custom integrations.

## Why Engram?

### Your data stays yours

All memory lives on your filesystem as plain markdown files. No cloud dependency, no subscriptions, no proprietary formats, no sending your private conversations to third-party servers. Back it up with git, rsync, or Time Machine. Move it between machines with a folder copy. You own your data completely.

### A real upgrade from default OpenClaw memory

OpenClaw's built-in memory is basic — it works for getting started, but lacks semantic search, entity tracking, lifecycle management, governance, and multi-agent isolation. Engram is a drop-in replacement that brings all of those capabilities while keeping the same local-first philosophy.

### Smart recall, not keyword search

Engram uses hybrid search (BM25 + vector + reranking via [QMD](https://github.com/tobilu/qmd)) to find semantically relevant memories. It doesn't just match keywords — it understands what you're working on and surfaces the right context.

### Flexible LLM routing — OpenAI, local, or gateway model chain

Use OpenAI for extraction and reranking, run entirely offline with a local LLM (Ollama, LM Studio), or route through the **gateway model chain** to use any provider with automatic fallback. The `local-llm-heavy` preset is optimized for fully local operation. See the [Local LLM Guide](docs/guides/local-llm.md) and the [Gateway Model Source](docs/config-reference.md#gateway-model-source) section for multi-provider setups.

### Progressive complexity

Start with zero config. Enable features as your needs grow:

| Level | What You Get |
|-------|-------------|
| **Defaults** | Automatic extraction, recall injection, entity tracking, lifecycle management |
| **+ Search tuning** | Choose from 6 search backends (QMD, Orama, LanceDB, Meilisearch, remote, noop) |
| **+ Capture control** | `implicit`, `explicit`, or `hybrid` capture modes for memory write policy |
| **+ Memory OS** | Memory boxes, graph reasoning, compounding, shared context, identity continuity |
| **+ LCM** | Lossless Context Management — never lose conversation context to compaction |
| **+ Parallel retrieval** | Three specialized agents (DirectFact, Contextual, Temporal) run in parallel — same latency, broader coverage |
| **+ Advanced** | Trust zones, causal trajectories, harmonic retrieval, evaluation harness, poisoning defense |

Use a preset to jump to a recommended level: `conservative`, `balanced`, `research-max`, or `local-llm-heavy`.

### Works with your tools

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Native plugin with automatic extraction and recall injection
- **[Codex CLI](https://github.com/openai/codex)** — MCP-over-HTTP with session-start hooks for automatic recall
- **Any MCP client** — stdio or HTTP transport, 8 tools available
- **Scripts & automation** — Authenticated REST API for custom integrations
- **Local LLMs** — Run extraction and reranking with local models (Ollama, LM Studio, etc.)

### Standalone Multi-Tenant Server

Run Engram as a standalone HTTP server that multiple agent harnesses share. Isolate tenants with namespace policies, feed conversations from any client via the observe endpoint, and search archived history with LCM full-text search. Works with OpenClaw, Codex CLI, Claude Code, and custom HTTP agents. See the [Standalone Server Guide](docs/guides/standalone-server.md).

### Built for production

- **672 tests** with CI enforcement
- **Evaluation harness** with benchmark packs, shadow recall recording, and CI delta gates
- **Governance system** with review queues, shadow/apply modes, and reversible transitions
- **Namespace isolation** for multi-agent deployments
- **Rate limiting** on write paths with idempotency support

## Features

### Core

- **Automatic memory extraction** — Facts, decisions, preferences, corrections extracted from conversations
- **Observe endpoint** — Feed conversation messages from any agent into the extraction pipeline via HTTP or MCP
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
- **Memory Cache** — Process-level singleton cache for `readAllMemories()` — turns 15s disk scans into <100ms cache hits, shared across all sessions
- **Semantic Consolidation** — Finds clusters of semantically similar memories, synthesizes canonical versions via LLM, archives originals to reduce bloat
- **Native Knowledge** — Search curated markdown (workspace docs, Obsidian vaults) without extracting into memory
- **Behavior Loop Tuning** — Runtime self-tuning of extraction and recall parameters

### Lossless Context Management (LCM)

When your AI agent hits its context window limit, the runtime silently compresses old messages — and that context is gone forever. LCM fixes this by proactively archiving every message into a local SQLite database and building a hierarchical summary DAG (directed acyclic graph) alongside it. When context gets compacted, LCM injects compressed session history back into recall, so your agent never loses track of what happened earlier in the conversation.

- **Proactive archiving** — Every message is indexed with full-text search before compaction can discard it
- **Hierarchical summaries** — Leaf summaries cover ~8 turns, depth-1 covers ~32, depth-2 ~128, etc.
- **Fresh tail protection** — Recent turns always use the most detailed (leaf-level) summaries
- **Three-level summarization** — Normal LLM summary, aggressive bullet compression, and deterministic truncation (guaranteed convergence, no LLM needed)
- **MCP expansion tools** — Agents can search, describe, or expand any part of conversation history on demand
- **Zero data loss** — Raw messages are retained for the configured retention period (default 90 days)

Enable it in your `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-engram": {
        "config": {
          "lcmEnabled": true
          // All other LCM settings have sensible defaults
        }
      }
    }
  }
}
```

See the [LCM Guide](docs/guides/lossless-context-management.md) for architecture details, configuration options, and how it complements native compaction.

### Parallel Specialized Retrieval (opt-in)

Engram's default retrieval runs a single hybrid search pass. Parallel Specialized Retrieval (inspired by [Supermemory's ASMR technique](https://blog.supermemory.ai/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/)) runs three specialized agents in parallel so total latency equals `max(agents)` not `sum(agents)`.

| Agent | What It Does | Cost |
|-------|-------------|------|
| **DirectFact** | Scans entity filenames for keyword overlap with the query | File I/O only, <5ms |
| **Contextual** | Existing hybrid BM25+vector search (unchanged) | Same as current |
| **Temporal** | Reads the temporal date index, returns recent memories with recency decay scoring | File I/O + math, <10ms |

**Zero additional LLM cost.** The DirectFact and Temporal agents reuse existing indexes with no new embeddings or inference. The Contextual agent is the same hybrid search already running.

Results from all three agents are merged by path, deduplicated, and weighted (`direct=1.0×, temporal=0.85×, contextual=0.7×`) before returning the top N results. Any agent error degrades gracefully without blocking the others.

Enable it in your `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-engram": {
        "config": {
          "parallelRetrievalEnabled": true
          // Optional tuning:
          // "parallelMaxResultsPerAgent": 20,
          // "parallelAgentWeights": { "direct": 1.0, "contextual": 0.7, "temporal": 0.85 }
        }
      }
    }
  }
}
```

Set `parallelMaxResultsPerAgent: 0` to disable an individual agent's results without disabling the feature entirely.

### Semantic Consolidation (opt-in)

Over time, memory stores accumulate redundant facts — the same information extracted multiple times across sessions, expressed slightly differently. Semantic consolidation finds clusters of similar memories using token overlap, synthesizes a single canonical version via LLM, and archives the originals. This reduces storage bloat, speeds up recall, and improves memory quality.

- **Conservative by default** — Only merges when 80%+ token overlap is detected across 3+ memories
- **LLM synthesis** — Uses your configured model to combine unique information from all cluster members
- **Safe archival** — Originals are archived (not deleted) with full provenance tracking
- **Configurable** — Adjust threshold, cluster size, excluded categories, model, and schedule
- **Excluded categories** — Corrections and commitments are never consolidated (configurable)

Enable it in your `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-engram": {
        "config": {
          "semanticConsolidationEnabled": true
          // Optional tuning:
          // "semanticConsolidationThreshold": 0.8,    // 0.8=conservative, 0.6=aggressive
          // "semanticConsolidationModel": "fast",      // "auto", "fast", or specific model
          // "semanticConsolidationIntervalHours": 168, // weekly (default)
          // "semanticConsolidationMaxPerRun": 100
        }
      }
    }
  }
}
```

Run manually from the CLI:

```bash
openclaw engram semantic-consolidate --dry-run    # Preview what would be merged
openclaw engram semantic-consolidate --verbose     # Run with detailed output
openclaw engram semantic-consolidate --threshold 0.6  # Override threshold
```

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

The HTTP server also hosts a lightweight operator UI at `http://127.0.0.1:4318/engram/ui/` for memory browsing, recall inspection, governance review, trust-zone promotion, and entity exploration.

### MCP Tools

Available via both stdio and HTTP transports:

| Tool | Purpose |
|------|---------|
| `engram.recall` | Retrieve relevant memories for a query |
| `engram.recall_explain` | Debug the last recall |
| `engram.day_summary` | Generate structured end-of-day summary from memory content |
| `engram.memory_get` | Fetch a specific memory by ID |
| `engram.memory_timeline` | View a memory's lifecycle history |
| `engram.memory_store` | Store a new memory |
| `engram.suggestion_submit` | Queue a memory for review |
| `engram.entity_get` | Look up a known entity |
| `engram.review_queue_list` | View the governance review queue |
| `engram.observe` | Feed conversation messages into memory pipeline (LCM + extraction) |
| `engram.lcm_search` | Full-text search over LCM-archived conversations |
| `engram_context_search` | Full-text search across all archived conversation history (LCM) |
| `engram_context_describe` | Get a compressed summary of a turn range (LCM) |
| `engram_context_expand` | Retrieve raw lossless messages for a turn range (LCM) |

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

# Memory maintenance
openclaw engram consolidate                  # Run standard consolidation
openclaw engram semantic-consolidate         # Run semantic dedup consolidation
openclaw engram semantic-consolidate --dry-run  # Preview without changes

# Access layer
openclaw engram access http-serve --token "$TOKEN"  # Start HTTP API
openclaw engram access mcp-serve   # Start stdio MCP server

# Trust-zone demos
openclaw engram trust-zone-demo-seed --dry-run       # Preview the opt-in buyer demo dataset
openclaw engram trust-zone-demo-seed                 # Explicitly seed the demo dataset
openclaw engram trust-zone-promote --record-id <id> --target-zone working --reason "Operator review"
```

### Trust-zone demo workflow

Trust zones now ship with a dedicated admin-console view plus an explicit demo seeding path for buyer-facing walkthroughs.

- **Never automatic** — Engram does not seed sample trust-zone records on install, startup, or feature enablement.
- **Explicit only** — demo records appear only after you run `openclaw engram trust-zone-demo-seed` or trigger the matching admin-console action.
- **Buyer-friendly story** — the trust-zone view surfaces provenance strength, promotion readiness, corroboration requirements, and operator promotion actions in one place.

The seeded scenario is `enterprise-buyer-v1`, which creates a small, opinionated dataset covering:

- quarantine records that are ready for review
- working records that are blocked on missing provenance
- working records that still need corroboration
- working records with independent corroboration support
- a trusted operator policy record

See the [full CLI reference](docs/api.md#cli-commands) for all commands.

## Configuration

All settings live in `openclaw.json` under `plugins.entries.openclaw-engram.config`. The table below shows the most commonly changed settings — Engram has **60+ configuration options** covering search backends, capture modes, memory OS features, namespaces, governance, benchmarking, and more.

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env)` | OpenAI API key (optional when using a local LLM) |
| `localLlmEnabled` | `false` | Enable Engram's local LLM path when `modelSource` is `plugin` |
| `localLlmUrl` | unset | Local LLM endpoint (e.g., `http://localhost:1234/v1`) |
| `localLlmModel` | unset | Local model name (e.g., `qwen2.5-32b-instruct`) |
| `model` | `gpt-5.2` | OpenAI model for extraction when `modelSource` is `plugin` and local LLM is disabled |
| `searchBackend` | `"qmd"` | Search engine: `qmd`, `orama`, `lancedb`, `meilisearch`, `remote`, `noop` |
| `captureMode` | `implicit` | Memory write policy: `implicit`, `explicit`, `hybrid` |
| `recallBudgetChars` | `maxMemoryTokens * 4` | Recall budget (default ~8K chars; set 64K+ for large-context models) |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage root |
| `memoryOsPreset` | unset | Quick config: `conservative`, `balanced`, `research-max`, `local-llm-heavy` |
| `lcmEnabled` | `false` | Enable Lossless Context Management (proactive session archive + summary DAG) |
| `semanticConsolidationEnabled` | `false` | Enable periodic semantic dedup of similar memories |
| `semanticConsolidationThreshold` | `0.8` | Token overlap threshold (0.8=conservative, 0.6=aggressive) |
| `semanticConsolidationModel` | `"auto"` | LLM for synthesis: `"auto"`, `"fast"`, or specific model |

**[See the full config reference for all 60+ settings](docs/config-reference.md)** including search backend configuration, namespace policies, Memory OS features, governance, evaluation harness, trust zones, causal trajectories, and more.

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
- [Standalone Server Guide](docs/guides/standalone-server.md) — Multi-tenant HTTP server for multiple agent harnesses
- [Local LLM Guide](docs/guides/local-llm.md) — Local-first extraction and reranking
- [Cost Control Guide](docs/guides/cost-control.md) — Budget mappings and presets
- [Namespaces](docs/namespaces.md) — Multi-agent memory isolation
- [Shared Context](docs/shared-context.md) — Cross-agent intelligence
- [Identity Continuity](docs/identity-continuity.md) — Consistent agent personality
- [Graph Reasoning](docs/architecture/graph-reasoning.md) — Opt-in graph traversal
- [Evaluation Harness](docs/evaluation-harness.md) — Benchmarks and CI delta gates
- [Operations](docs/operations.md) — Backup, export, maintenance
- [Lossless Context Management](docs/guides/lossless-context-management.md) — Never lose context to compaction
- [Enable All Features](docs/enable-all-v8.md) — Full-feature config profile
- [Migration Guide](docs/guides/migrations.md) — Upgrading from older versions
- [Platform Migration Guide](docs/guides/platform-migration.md) — Migrating to the monorepo architecture (v9.1.36+)
- [Hermes Setup](docs/integration/hermes-setup.md) — HTTP client for remote Engram instances
- [Deployment Topologies](docs/integration/deployment-topologies.md) — Localhost, LAN, remote, containerized, standalone

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests for new functionality
4. Ensure `npm test` (672 tests) and `npm run check-types` pass
5. Submit a pull request

## Sponsorship

If Engram is useful to you, consider [sponsoring the project](https://github.com/sponsors/joshuaswarren). Sponsorship helps fund continued development, new integrations, and keeping Engram free and open source.

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?style=for-the-badge)](https://github.com/sponsors/joshuaswarren)

## License

[MIT](LICENSE)
