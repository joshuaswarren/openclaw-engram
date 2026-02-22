# Architecture

Engram is a local-first memory plugin for the [OpenClaw](https://github.com/openclaw/openclaw) gateway. For a detailed walkthrough, see the docs below.

## System Overview

See **[docs/architecture/overview.md](architecture/overview.md)** for the full system design, component map, and data model.

## Key Design Decisions

- **Local-first storage** — all memories live as plain markdown files on disk; no external database required.
- **Three-phase flow** — *recall* (before each agent session), *buffer* (after each turn), *extract* (periodic LLM call).
- **OpenAI Responses API** — extraction uses structured outputs via the Responses API, never Chat Completions.
- **QMD for retrieval** — hybrid BM25 + vector + reranking via an external `qmd` process; degrades gracefully when unavailable.
- **Plugin architecture** — integrates with OpenClaw via hooks (`gateway_start`, `before_agent_start`, `agent_end`) and registered tools/commands.

## Component Map

| Component | File | Role |
|-----------|------|------|
| Orchestrator | `src/orchestrator.ts` | Coordinates all phases |
| Storage | `src/storage.ts` | Reads/writes markdown + YAML frontmatter |
| Buffer | `src/buffer.ts` | Smart turn accumulation with signal-based triggers |
| Extraction | `src/extraction.ts` | LLM extraction engine (OpenAI Responses API) |
| QMD client | `src/qmd.ts` | Hybrid search (BM25 + vector + reranking) |
| Retrieval | `src/retrieval.ts` | Recall pipeline: filter → rerank → cap → format |
| HiMem | `src/himem.ts` | Episode/Note dual-store classification (v8.0) |
| Boxes | `src/boxes.ts` | Memory Box builder + Trace Weaver (v8.0) |
| Tools | `src/tools.ts` | Agent-callable memory tools |

## Further Reading

- [Architecture Overview](architecture/overview.md) — full internals
- [Retrieval Pipeline](architecture/retrieval-pipeline.md) — how recall works
- [Memory Lifecycle](architecture/memory-lifecycle.md) — write, consolidation, expiry
