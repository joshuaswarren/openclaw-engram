# @remnic/core

Framework-agnostic memory engine for AI agents. Orchestration, storage, extraction, search, and trust zones -- all local, all private.

Part of [Remnic](https://github.com/joshuaswarren/remnic), the universal memory layer for AI agents.

## Install

```bash
npm install @remnic/core
```

## What it does

Remnic Core is the engine that powers persistent memory across AI agent sessions. It handles:

- **Memory orchestration** -- three-phase flow: recall before sessions, buffer during, extract after
- **Storage** -- plain markdown files with YAML frontmatter on your local filesystem
- **Extraction** -- GPT-5.2 or local LLM (Ollama, LM Studio) extracts durable knowledge from conversations
- **Search** -- hybrid BM25 + vector + reranking via QMD
- **Trust zones** -- namespace isolation and access control for multi-agent setups
- **Entity tracking** -- people, projects, tools, and their relationships
- **Consolidation** -- periodic merging, deduplication, and summarization

## Usage

Most users interact with Remnic through a higher-level package:

| Package | Use case |
|---------|----------|
| [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw) | OpenClaw gateway plugin |
| [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) | Standalone CLI and daemon |
| [`@remnic/server`](https://www.npmjs.com/package/@remnic/server) | Standalone HTTP + MCP server |

Use `@remnic/core` directly when building a custom integration or embedding the memory engine in your own agent framework.

```typescript
import { Orchestrator } from "@remnic/core";
```

## Fallback LLM

The core includes a fallback LLM client that resolves providers from your gateway config or OpenClaw's built-in provider catalog. It supports OpenAI-compatible and Anthropic APIs with automatic auth resolution and provider fallback chains.

## License

MIT
