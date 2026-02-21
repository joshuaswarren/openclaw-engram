# Engram Docs Map (v8 Reorg Start)

This is the start of a full docs overhaul. Use this map as the canonical entrypoint.

## Getting Started
- `../README.md` - install, quick config, tool list
- `setup-config-tuning.md` - production tuning, QMD, local LLM setup

## Retrieval & Memory Behavior
- `advanced-retrieval.md` - retrieval controls (rerank/query expansion/feedback)
- `context-retention.md` - transcript retention, summaries, semantic recall
- `namespaces.md` - multi-agent namespace isolation

## Intelligence Layers
- `shared-context.md` - shared cross-agent context
- `compounding.md` - weekly synthesis and mistakes compounding

## Operations
- `import-export.md` - backup/export/import workflows
- `ops/pr-review-hardening-playbook.md` - mandatory pre-push review hardening checklist
- `ops/plugin-engineering-patterns.md` - generalized engineering patterns for retrieval/intent/cache changes
- `ops/rca-pr11-review-churn-2026-02-21.md` - postmortem + lessons from PR #11 review churn

## Plans / Roadmaps
- `plans/2026-02-21-engram-memory-os-roadmap.md` - v8 major roadmap (memory OS architecture)

## Planned Structure (next PR phases)
- `docs/guide/` for user guides and setup paths
- `docs/reference/` for config/tool schema reference
- `docs/architecture/` for retrieval/write pipeline internals
- `docs/ops/` for runbooks, failure modes, and hardening
