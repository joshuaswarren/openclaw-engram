# Engram Docs

## Getting Started

- [Getting Started](getting-started.md) — Install, setup, first-run verification
- [Search Backends](search-backends.md) — Choosing and configuring search engines (v9.0)
- [Enable All Features](enable-all-v8.md) — Full-feature config profile
- [Config Reference](config-reference.md) — Every setting, default, and description

## Architecture

- [Overview](architecture/overview.md) — System design, components, storage layout
- [Retrieval Pipeline](architecture/retrieval-pipeline.md) — How recall works end-to-end
- [Memory Lifecycle](architecture/memory-lifecycle.md) — Write, consolidation, expiry
- [Writing a Search Backend](writing-a-search-backend.md) — Build your own search adapter (v9.0)

## Operations

- [Operations](operations.md) — Backup, export, hourly summaries, CLI, logs
- [Import / Export](import-export.md) — Portable backups and migration
- [ops/pr-review-hardening-playbook.md](ops/pr-review-hardening-playbook.md) — Pre-push review checklist
- [ops/plugin-engineering-patterns.md](ops/plugin-engineering-patterns.md) — Engineering patterns for retrieval/intent/cache

## Feature Guides

- [Advanced Retrieval](advanced-retrieval.md) — Reranking, query expansion, feedback loop
- [Context Retention](context-retention.md) — Transcript indexing, hourly summaries
- [Namespaces](namespaces.md) — Multi-agent memory isolation (v3.0)
- [Shared Context](shared-context.md) — Cross-agent shared intelligence (v4.0)
- [Compounding](compounding.md) — Weekly synthesis and mistake learning (v5.0)
- [Identity Continuity](identity-continuity.md) — Continuity artifacts, templates, and rollout safety model (v8.4)
- [Graph Dashboard](graph-dashboard.md) — Optional live graph observability server + patch stream (v8.8)

## Plans / Roadmaps

- [v8 Memory OS Roadmap](plans/2026-02-21-engram-memory-os-roadmap.md) — Major roadmap
