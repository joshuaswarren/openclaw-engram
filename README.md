# Remnic

**Persistent, private memory for AI agents.** Your agents forget everything between sessions — Remnic fixes that.

Remnic gives AI agents long-term memory that survives across conversations. Decisions, preferences, project context, personal details, past mistakes — everything your agent learns persists and resurfaces exactly when it's needed. All data stays on your machine as plain markdown files. No cloud services, no subscriptions, no sharing your data with third parties.

[![npm version](https://img.shields.io/npm/v/@remnic/cli)](https://www.npmjs.com/package/@remnic/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink)](https://github.com/sponsors/joshuaswarren)

> **Engram is now Remnic.** Canonical packages live under the `@remnic/*` scope:
> [`@remnic/core`](https://www.npmjs.com/package/@remnic/core),
> [`@remnic/server`](https://www.npmjs.com/package/@remnic/server),
> [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli).
> OpenClaw installs should use [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw).
> The legacy `engram` CLI name remains available as a forwarder during the rename window.
> Python users: [`remnic-hermes`](https://pypi.org/project/remnic-hermes/) on PyPI.

## Support Remnic

Every bit of support is genuinely appreciated and helps keep this project alive and free for everyone.

If you're able to, [sponsoring on GitHub](https://github.com/sponsors/joshuaswarren) or sending a Lightning donation to `joshuaswarren@strike.me` directly funds continued development, new integrations, and keeping Remnic open source.

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?style=for-the-badge)](https://github.com/sponsors/joshuaswarren)

If financial support isn't an option, you can still make a big difference — [star the repo on GitHub](https://github.com/joshuaswarren/remnic), share it on social media, or recommend it to a friend or colleague. Word of mouth is how most people find Remnic, and it means the world.

## The Problem

Every AI agent session starts from zero. Your agent doesn't know your name, your projects, the decisions you've already made, or the bugs you already debugged. Whether it's a personal assistant, a coding agent, a research agent, or a multi-agent team — they all forget everything between conversations. You re-explain the same context over and over, and your agents still make the same mistakes.

OpenClaw's built-in memory works for simple cases, but it doesn't scale. It lacks semantic search, lifecycle management, entity tracking, and governance. Third-party memory services exist, but they cost money and require sending your private data to someone else's servers.

## The Solution

Remnic is an open-source, local-first memory system that replaces OpenClaw's default memory with something much more capable — while keeping everything on your machine. It watches your agent conversations, extracts durable knowledge, and injects the right memories back at the start of every session. Use OpenAI or a **local LLM** (Ollama, LM Studio, etc.) for extraction — your choice.

Remnic is the **universal memory layer for AI agents**. It works natively with **[OpenClaw](https://github.com/openclaw/openclaw)**, **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)**, **[Codex CLI](https://github.com/openai/codex)**, **[Hermes Agent](https://github.com/NousResearch/hermes-agent)**, and any **MCP-compatible client** (Replit, Cursor, etc.). When you tell any agent a preference, every agent knows it — they share one memory store.

Architecture rule: standalone Remnic is first-class. `@remnic/core`, `@remnic/server`, and `@remnic/cli` own the memory engine and must stay host-agnostic. OpenClaw, Hermes, Codex, Claude Code, and future integrations are thin adapters over that shared core, and adapter work should always follow the host's current upstream SDK and documentation instead of recreating host-native behavior inside Remnic.

| Without Remnic | With Remnic |
|---|---|
| Re-explain who you are and what you're working on | Agent recalls your identity, projects, and preferences automatically |
| Repeat context for every task | Entity knowledge surfaces people, projects, tools, and relationships on demand |
| Lose debugging and research context between sessions | Past root causes, dead ends, and findings are recalled — no repeated work |
| Manually restate preferences every session | Preferences persist across sessions, agents, and projects |
| Context-switching tax when resuming work | Session-start recall brings you back to speed instantly |
| Default OpenClaw memory doesn't scale | Hybrid search, lifecycle management, namespaces, and governance |
| Third-party memory services cost money and share your data | Everything stays local — your filesystem, your rules |

## Quick install (OpenClaw)

If you have OpenClaw installed, the fastest path to working Remnic memory is:

```bash
# 1. Install the plugin package
openclaw plugins install @remnic/plugin-openclaw --pin

# 2. Wire up the memory slot automatically
remnic openclaw install

# 3. Restart the gateway
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# 4. Verify everything is working
remnic doctor
```

`remnic openclaw install` writes `plugins.entries["openclaw-remnic"]` and `plugins.slots.memory = "openclaw-remnic"` to `~/.openclaw/openclaw.json`. Without the slot, hooks never fire — see [Troubleshooting: hooks aren't firing](#troubleshooting-hooks-arent-firing) for details.

## Installation

### Option 1: Install from the CLI

```bash
openclaw plugins install @remnic/plugin-openclaw --pin
```

### Option 2: Ask your OpenClaw agent to install it

Tell any OpenClaw agent:

> Install the @remnic/plugin-openclaw plugin and configure it as my memory system.

Your agent will run the install command, update `openclaw.json`, and restart the gateway for you.

### Option 3: Developer install from source

```bash
git clone https://github.com/joshuaswarren/remnic.git \
  ~/.openclaw/extensions/remnic
cd ~/.openclaw/extensions/remnic
pnpm install && pnpm run build
```

> **Note:** This repo uses [pnpm](https://pnpm.io/) workspaces. `npm ci` / `npm install` will fail on `workspace:` specifiers. Install pnpm first: `npm install -g pnpm`.

### Option 4: Standalone (no OpenClaw)

**From npm (recommended):**

```bash
npm install -g @remnic/cli      # Installs `remnic` plus the legacy `engram` forwarder
remnic init                     # Create remnic.config.json
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
remnic daemon start             # Start background server
remnic status                   # Verify it's running
remnic query "hello" --explain  # Test query with tier breakdown
```

**From source** (requires [Node.js](https://nodejs.org/) 22.12+ and [pnpm](https://pnpm.io/)):

```bash
git clone https://github.com/joshuaswarren/remnic.git
cd remnic
pnpm install && pnpm run build
cd packages/remnic-cli && pnpm link --global  # Makes `remnic` and `engram` available on PATH
cd ../..
remnic init                     # Create remnic.config.json
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
remnic daemon start             # Start background server
remnic status                   # Verify it's running
remnic query "hello" --explain  # Test query with tier breakdown
```

> **Note:** `remnic` is the canonical CLI. The legacy `engram` binary is a compatibility forwarder to the same implementation. Running `pnpm link --global` from `packages/remnic-cli/` (not the repo root) makes both names available on PATH. Alternatively, invoke directly: `npx tsx packages/remnic-cli/src/index.ts <command>`.

The standalone CLI provides 15+ commands for memory management, project onboarding, curation, diff-aware sync, dedup, connectors, spaces, and benchmarks -- all without requiring OpenClaw. See the [Platform Migration Guide](docs/guides/platform-migration.md) for the full command reference.

### Option 5: Connect Other AI Agents

Once the Remnic daemon is running, connect any supported agent:

```bash
remnic connectors install claude-code   # Claude Code (hooks + MCP)
remnic connectors install codex-cli     # Codex CLI (hooks + MCP + memory extension)
remnic connectors install replit        # Replit (MCP only)
pip install remnic-hermes               # Hermes Agent (Python MemoryProvider)
```

For Codex CLI, installation also drops a phase-2 memory extension at
`<codex_home>/memories_extensions/remnic/instructions.md` so Codex's
consolidation sub-agent auto-discovers Remnic. Opt out with
`--config installExtension=false` if you prefer to manage Codex extensions
yourself.

Each connector generates a unique auth token, installs the appropriate plugin/hooks, and verifies the connection. All agents share the same memory store — tell one agent your preference, and every agent remembers it.

| Platform | Integration | Auto-recall | Auto-observe |
|----------|------------|-------------|--------------|
| **OpenClaw** | Memory slot plugin | Every session | Every response |
| **Claude Code** | Native hooks + MCP | Every prompt | Every tool use |
| **Codex CLI** | Native hooks + MCP | Every prompt | Every tool use |
| **Hermes** | Python MemoryProvider | Every LLM call | Every turn |
| **Replit** | MCP only | On demand | On demand |

### Configure

After installation, add the Remnic bridge plugin to your `openclaw.json`:

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

> **Gateway model source:** When `modelSource` is `"gateway"`, Remnic routes all LLM calls (extraction, consolidation, reranking) through an OpenClaw agent persona's model chain instead of its own config. Extraction starts on the `gatewayAgentId` chain directly in this mode; `localLlm*` settings do not control primary extraction order. Define agent personas in `openclaw.json → agents.list[]` with a `primary` model and `fallbacks[]` array — Remnic tries each in order until one succeeds. This lets you build multi-provider fallback chains like Fireworks → local LLM → cloud OpenAI. See the [Gateway Model Source](docs/config-reference.md#gateway-model-source) guide for full setup.

Restart the gateway:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway   # macOS
# or: systemctl restart openclaw-gateway                    # Linux
```

Start a conversation — Remnic begins learning immediately.

> **Note:** This shows only the minimal config. Remnic has 60+ configuration options for search backends, capture modes, memory OS features, and more. See the [full config reference](docs/config-reference.md) for every setting.

### Extraction importance gate

Remnic scores every extracted fact locally (see `src/importance.ts`) and uses that score as a write gate. Facts whose level falls below `extractionMinImportanceLevel` are dropped before they ever hit disk, so turn-level chatter like `"hi"`, `"k"`, or heartbeat pings never become fact memories.

Default: `"low"` — only `"trivial"` content is dropped. Raise to `"normal"` or higher for a stricter gate.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-engram": {
        "config": {
          // Allowed values: "trivial" | "low" | "normal" | "high" | "critical"
          "extractionMinImportanceLevel": "normal"
        }
      }
    }
  }
}
```

Category boosts still apply before the gate, so corrections, principles, preferences, and commitments stay above `"normal"` even when their raw text would otherwise score low. Every gated fact increments the `importance_gated` counter (grep `metric:importance_gated` in `~/.openclaw/logs/gateway.log`) and the final extraction log line reports the gated count.

### Inline source attribution (opt-in, issue #369)

Extracted facts can optionally carry a compact provenance tag inline in the fact body — not just in YAML frontmatter — so the citation survives prompt injection, copy/paste, and LLM quoting. When an agent later quotes a memory back or a user asks "where did you learn that?", the source travels with the claim.

Default format:

```
The foo service uses Redis for rate limiting. [Source: agent=planner, session=main, ts=2026-04-10T14:25:07Z]
```

Enable it per plugin:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-engram": {
        "config": {
          "inlineSourceAttributionEnabled": true,
          // Optional: customize the tag format.
          // Placeholders: {agent}, {session}, {sessionId}, {ts}, {date}
          "inlineSourceAttributionFormat": "[Source: agent={agent}, session={sessionId}, ts={ts}]"
        }
      }
    }
  }
}
```

Properties:

- **Off by default** to preserve backwards compatibility with downstream consumers that expect raw fact text.
- **Inline** — the tag is part of the stored fact body, so it flows through every write site (direct writes, chunked writes, shared-namespace promotion, verbatim artifacts) and recall injection without special handling.
- **Legacy-safe** — facts written before the flag was enabled still read and recall normally; nothing is retroactively rewritten.
- **Non-destructive** — facts that already carry a citation (e.g. relayed from an upstream system) are left untouched.
- **Machine-parseable** — `parseCitation(text)` and `stripCitation(text)` are exported from `@remnic/core` for callers that want the raw body (e.g. for dedup hashing, display, or verification tooling). Malformed citations never throw.

See `packages/remnic-core/src/source-attribution.ts` for the helpers and `packages/remnic-core/src/source-attribution.test.ts` for the round-trip contract.

### Verify installation

```bash
openclaw engram setup --json         # Validates config, scaffolds directories
openclaw engram doctor --json        # Health diagnostics with remediation hints
openclaw engram config-review --json # Opinionated config tuning recommendations
```

## Troubleshooting: hooks aren't firing

**Symptom:** Remnic appears installed but no memories are created. The gateway log shows no `[remnic]` lines after conversations.

**Root cause:** OpenClaw gates memory plugins on `plugins.slots.memory`. If this slot is not set to the plugin's id, OpenClaw skips `register(api)` entirely — no hooks fire, no memory is stored or recalled.

### Quick fix

```bash
remnic openclaw install   # Sets plugins.slots.memory = "openclaw-remnic"
```

Restart the gateway after running this command.

### How to verify hooks are firing

After restarting, check the gateway log for this line:

```
[remnic] gateway_start fired — Remnic memory plugin is active (id=openclaw-engram, memoryDir=~/.openclaw/workspace/memory/local)
```

On macOS:
```bash
grep "gateway_start fired" ~/.openclaw/logs/gateway.log
```

If the line is absent, run `remnic doctor` to see which check is failing:

```
remnic doctor
```

The doctor output will show:
- `OpenClaw config file` — whether `openclaw.json` exists and is valid JSON
- `OpenClaw plugins.entries` — whether the entries object is present
- `OpenClaw plugin entry` — whether `openclaw-remnic` (or legacy `openclaw-engram`) entry exists
- `OpenClaw plugins.slots.memory` — whether the slot is set and points to an entry
- `OpenClaw memoryDir` — whether the configured memory directory exists on disk

Each failing check includes a remediation hint pointing to `remnic openclaw install`.

### Manual fix

If you prefer to edit `~/.openclaw/openclaw.json` directly:

```json
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "memoryDir": "~/.openclaw/workspace/memory/local"
        }
      }
    },
    "slots": {
      "memory": "openclaw-remnic"
    }
  }
}
```

Both `entries["openclaw-remnic"]` and `slots.memory = "openclaw-remnic"` are required. See [docs/integration/plugin-id-and-memory-namespaces.md](docs/integration/plugin-id-and-memory-namespaces.md) for the full design note.

## Using Remnic with Codex CLI

Start the Remnic server directly for the current shell session:

```bash
# Generate a token
export REMNIC_AUTH_TOKEN="$(openssl rand -base64 32)"

npx remnic-server --host 127.0.0.1 --port 4318 --auth-token "$REMNIC_AUTH_TOKEN"
```

If you want to use `remnic daemon start`, persist the token in
`remnic.config.json` first. `daemon start` will hand off to launchd/systemd
when a service is installed, and those service templates read `server.authToken`
from config rather than inheriting your shell's exported token.

The HTTP API path remains `/engram/v1/...` during the v1.x compatibility window.

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.remnic]
url = "http://127.0.0.1:4318/mcp"
bearer_token_env_var = "REMNIC_AUTH_TOKEN"
```

That's it. Codex now has access to Remnic's recall, store, and entity tools. See the [full Codex integration guide](docs/guides/codex-cli.md) for session-start hooks, cross-machine setup, and automatic recall at session start.

## Using Remnic with Any MCP Client

Run the stdio MCP server:

```bash
openclaw engram access mcp-serve
```

Point your MCP client's command at `openclaw engram access mcp-serve`. This
is the OpenClaw-hosted stdio compatibility path. For standalone Remnic installs,
prefer the HTTP MCP endpoint exposed by `remnic daemon start` or `remnic-server`.

**Claude Code (MCP over HTTP):** Start the Remnic server, then add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "remnic": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${REMNIC_AUTH_TOKEN}"
      }
    }
  }
}
```

See the [Standalone Server Guide](docs/guides/standalone-server.md) for multi-tenant setups and connecting multiple agent harnesses.

## Standalone Usage

Remnic also works as a standalone tool without OpenClaw. Install and run the CLI directly:

```bash
npm install -g @remnic/cli
remnic init                     # create remnic.config.json
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
remnic daemon start             # start background server
remnic query "hello"            # verify
```

The CLI provides 15+ commands for querying, onboarding projects, curating files, managing spaces, running benchmarks, and more. See the [full CLI reference](docs/api.md#standalone-cli-commands) for all commands.

### Connect to any coding tool

Remnic works with 10+ coding tools via MCP or HTTP. See the [Connector Setup Guide](docs/integration/connector-setup.md) for config snippets for Claude Code, Codex CLI, Cursor, GitHub Copilot, Cline, Roo Code, Windsurf, Amp, Replit, and any generic MCP client.

OpenClaw remains the recommended path for most users. The standalone CLI is useful for CI/CD pipelines, scripted memory operations, and environments without OpenClaw.

### Package Architecture

```
@remnic/core            — Framework-agnostic engine (re-exports orchestrator, config, storage, search, extraction, graph, trust zones)
@remnic/cli             — Standalone CLI binary (15+ commands)
@remnic/server          — Standalone HTTP/MCP server
@remnic/bench           — Benchmarks + CI regression gates
@remnic/hermes-provider — HTTP client for remote Remnic instances
```

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

Engram is organized as a monorepo with a core engine, standalone server/CLI, and native plugins for multiple AI platforms:

```
                         ┌─────────────────┐
                         │  @remnic/core   │
                         │  (engine)       │
                         └────────┬────────┘
                                  │
        ┌──────────┬──────────┬───┴────┬──────────┬──────────┐
        │          │          │        │          │          │
  ┌─────┴─────┐ ┌─┴──────┐ ┌┴─────┐ ┌┴────────┐ │  Native  │
  │ @remnic/  │ │@remnic/│ │remnic│ │@remnic/  │ │ Plugins  │
  │ cli       │ │server  │ │-hermes│ │plugin-   │ │          │
  │           │ │        │ │       │ │openclaw  │ │          │
  └───────────┘ └────────┘ └──────┘ └─────────┘ └──────────┘
                    │                             │
              ┌─────┴─────┐        ┌──────────────┼──────────┐
              │ @remnic/  │        │              │          │
              │ bench     │   claude-code     codex     replit
              └───────────┘
```

| Package | npm/PyPI | Description |
|---------|----------|-------------|
| `@remnic/core` | [![npm](https://img.shields.io/npm/v/@remnic/core)](https://www.npmjs.com/package/@remnic/core) | Framework-agnostic engine — orchestrator, storage, search, extraction, graph, trust zones |
| `@remnic/server` | [![npm](https://img.shields.io/npm/v/@remnic/server)](https://www.npmjs.com/package/@remnic/server) | Standalone HTTP/MCP server with multi-token auth. Run as daemon via launchd/systemd |
| `@remnic/cli` | [![npm](https://img.shields.io/npm/v/@remnic/cli)](https://www.npmjs.com/package/@remnic/cli) | CLI binary — memory management, daemon lifecycle, connectors, tokens, spaces, benchmarks |
| `@remnic/hermes-provider` | [![npm](https://img.shields.io/npm/v/@remnic/hermes-provider)](https://www.npmjs.com/package/@remnic/hermes-provider) | TypeScript HTTP client for remote Remnic instances |
| `@remnic/bench` | (private) | Latency ladder benchmarks with CI regression gates |
| `@remnic/plugin-openclaw` | [![npm](https://img.shields.io/npm/v/@remnic/plugin-openclaw)](https://www.npmjs.com/package/@remnic/plugin-openclaw) | OpenClaw adapter — thin bridge (embedded or delegate mode) |
| `remnic-hermes` | [![PyPI](https://img.shields.io/pypi/v/remnic-hermes)](https://pypi.org/project/remnic-hermes/) | Python MemoryProvider for Hermes Agent |
| `@remnic/plugin-claude-code` | Installed via `remnic connectors install` | Native Claude Code plugin — hooks, skills, MCP |
| `@remnic/plugin-codex` | (installed via `remnic connectors install`) | Native Codex CLI plugin — hooks, skills, MCP |

The old `@joshuaswarren/openclaw-engram` package is **deprecated**. Use `@remnic/plugin-openclaw` for OpenClaw installs and `@remnic/*` for standalone or multi-platform use.

## Why Remnic?

### Your data stays yours

All memory lives on your filesystem as plain markdown files. No cloud dependency, no subscriptions, no proprietary formats, no sending your private conversations to third-party servers. Back it up with git, rsync, or Time Machine. Move it between machines with a folder copy. You own your data completely.

### A real upgrade from default OpenClaw memory

OpenClaw's built-in memory is basic — it works for getting started, but lacks semantic search, entity tracking, lifecycle management, governance, and multi-agent isolation. Engram is a drop-in replacement that brings all of those capabilities while keeping the same local-first philosophy.

### Smart recall, not keyword search

Remnic uses hybrid search (BM25 + vector + reranking via [QMD](https://github.com/tobilu/qmd)) to find semantically relevant memories. It doesn't just match keywords — it understands what you're working on and surfaces the right context.

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
| **+ Quality gates** | Extraction judge, semantic chunking, MECE taxonomy, page versioning |
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

### Extraction & Processing (opt-in)

- **Extraction Judge** — LLM-as-judge post-extraction filter that evaluates fact durability before write. Has shadow mode for calibration. Opt-in via `extractionJudgeEnabled`. (issue #376)
- **Semantic Chunking** — Smoothing-based topic boundary detection using sentence embeddings and cosine similarity, as an alternative to recursive chunking. Opt-in via `semanticChunkingEnabled`. (issue #368)
- **OAI-mem-citation Blocks** — Recall responses emit `<oai-mem-citation>` blocks matching the Codex citation format for memory attribution and usage tracking. Opt-in via `citationsEnabled`. (issue #379)

### Organization & Taxonomy (opt-in)

- **MECE Taxonomy** — Mutually Exclusive, Collectively Exhaustive knowledge directory with resolver decision tree for deterministic memory categorization. Opt-in via `taxonomyEnabled`. (issue #366)
- **Enrichment Pipeline** — Importance-tiered API spend for entity enrichment from external sources with a provider registry. Opt-in via `enrichmentEnabled`. (issue #365)

### Storage & Lifecycle (opt-in)

- **Page Versioning** — Snapshot-based history for memory files. Every overwrite saves a numbered snapshot in a sidecar directory. List, inspect, diff, and revert. Opt-in via `versioningEnabled`. (issue #371)
- **Binary Lifecycle Management** — Three-stage pipeline (mirror, redirect, clean) for binary files in the memory directory with configurable storage backends. Opt-in via `binaryLifecycleEnabled`. (issue #367)

### Integrations & Extensions

- **Codex Marketplace** — Install Remnic via `codex marketplace add joshuaswarren/remnic`. Marketplace manifest at repo root. (issue #418)
- **Memory Extension Publisher Contract** — Pluggable contract for installing host-specific instruction files into any AI agent host's extension directory. Generalizes the pattern previously hard-coded for Codex. (issue #381)
- **Memory Extension Discovery** — Third-party memory extensions provide structured instructions that influence consolidation, auto-discovered from extension directories. (issue #382)

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

Remnic exposes one shared service layer through multiple transports. During the
v1.x compatibility window, the HTTP API path remains `/engram/v1/...` and the
legacy `engram.*` MCP aliases still work.

### HTTP API

```bash
remnic daemon start
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

The HTTP server exposes an MCP JSON-RPC endpoint at `POST /mcp`, allowing remote MCP clients to use Remnic tools over HTTP:

```bash
npx remnic-server --host 0.0.0.0 --port 4318 --auth-token "$REMNIC_AUTH_TOKEN"
```

For namespace-enabled deployments, configure `server.principal` in `remnic.config.json` so it matches a `writePrincipals` entry for your target namespace. Deployments with `namespacesEnabled: false` (the default) do not need a principal.

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

# Daily context briefing (#370)
remnic briefing                                  # Yesterday's briefing (markdown)
remnic briefing --since 3d --focus project:alpha # Focused 3-day lookback
remnic briefing --format json --save             # JSON + dated file in $REMNIC_HOME/briefings

# Page versioning
remnic versions list <page-path>                  # List version history for a memory file
remnic versions show <page-path> <version-id>     # Show a specific version snapshot
remnic versions diff <page-path> <v1> <v2>        # Diff two versions of a memory file
remnic versions revert <page-path> <version-id>   # Revert a file to a previous version

# MECE taxonomy
remnic taxonomy show                              # Show taxonomy categories and priorities
remnic taxonomy resolver                          # Generate or display resolver decision tree
remnic taxonomy add <id> <name>                   # Add a taxonomy category
remnic taxonomy remove <id>                       # Remove a taxonomy category

# Entity enrichment
remnic enrich <entity-name|--all|audit|providers> [--dry-run]   # Run enrichment pipeline

# Binary lifecycle
remnic binary scan                                # Scan for binary files in memory directory
remnic binary status                              # Show binary lifecycle status
remnic binary run [--dry-run]                     # Run lifecycle (redirect/clean) for binaries
remnic binary clean --force                       # Force-clean binaries past grace period

# Access layer
remnic daemon start                # Start HTTP API + managed daemon
openclaw engram access mcp-serve   # Start OpenClaw-hosted stdio MCP server

# Trust-zone demos
openclaw engram trust-zone-demo-seed --dry-run       # Preview the opt-in buyer demo dataset
openclaw engram trust-zone-demo-seed                 # Explicitly seed the demo dataset
openclaw engram trust-zone-promote --record-id <id> --target-zone working --reason "Operator review"
```

### Trust-zone demo workflow

Trust zones now ship with a dedicated admin-console view plus an explicit demo seeding path for buyer-facing walkthroughs.

- **Never automatic** — Remnic does not seed sample trust-zone records on install, startup, or feature enablement.
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
| `extractionJudgeEnabled` | `false` | LLM-as-judge post-extraction durability filter |
| `semanticChunkingEnabled` | `false` | Topic-boundary chunking via sentence embeddings |
| `versioningEnabled` | `false` | Snapshot-based page versioning with history and revert |
| `citationsEnabled` | `false` | Emit `oai-mem-citation` blocks in recall responses |
| `taxonomyEnabled` | `false` | MECE knowledge directory with resolver decision tree |
| `enrichmentEnabled` | `false` | External entity enrichment pipeline |
| `binaryLifecycleEnabled` | `false` | Binary file lifecycle management (mirror/redirect/clean) |

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
- [Hermes Setup](docs/integration/hermes-setup.md) — HTTP client for remote Remnic instances
- [Deployment Topologies](docs/integration/deployment-topologies.md) — Localhost, LAN, remote, containerized, standalone
- [Extraction Judge](docs/architecture/extraction-judge.md) — LLM-as-judge fact-worthiness gate
- [Semantic Chunking](docs/architecture/semantic-chunking.md) — Topic-boundary detection
- [Page Versioning](docs/architecture/page-versioning.md) — Snapshot-based history and revert
- [Citations](docs/architecture/citations.md) — OAI-mem-citation block format
- [Memory Extension Publishers](docs/architecture/memory-extension-publishers.md) — Pluggable publisher contract
- [MECE Taxonomy](docs/architecture/mece-taxonomy.md) — Knowledge directory with resolver
- [Enrichment Pipeline](docs/architecture/enrichment-pipeline.md) — Entity enrichment from external sources
- [Binary Lifecycle](docs/architecture/binary-lifecycle.md) — Binary file management
- [Memory Extensions](docs/architecture/memory-extensions.md) — Third-party extension discovery
- [Codex Marketplace](docs/plugins/codex-marketplace.md) — Marketplace installation

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests for new functionality
4. Ensure `npm test` (672 tests) and `npm run check-types` pass
5. Submit a pull request

## License

[MIT](LICENSE)
