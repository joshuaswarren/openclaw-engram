# Migrations Guide

This guide covers two migrations:

1. moving from hand-tuned advanced flags to `memoryOsPreset`
2. moving from historical local plan files to the GitHub Project for roadmap sequencing

## Config Migration

If your config grew by copying old v8 examples, collapse it first:

1. Choose the nearest preset: `conservative`, `balanced`, `research-max`, or `local-llm-heavy`.
2. Delete advanced flags that now match the preset.
3. Re-add only the values you intentionally want to override.

Example:

```jsonc
{
  "memoryOsPreset": "research-max",
  "maxMemoryTokens": 2800,
  "graphRecallEnabled": false
}
```

That is easier to review than carrying a large copied block of defaults.

## Backward-Compatible Alias

Older docs sometimes used `research` as a preset label. The config parser still accepts it, but the canonical name is `research-max`.

## Documentation Migration

The roadmap source of truth is now the GitHub Project:

- [Engram Feature Roadmap](https://github.com/users/joshuaswarren/projects/1)

Use `docs/plans/` only for architecture context after you already know the active project item.

Good workflow:

1. check the GitHub Project for order, blockers, and coordination
2. read the relevant issue
3. open the matching historical plan only if you need deeper design rationale

## Platform Migration (v9.1.36+)

The v9.1.36 release introduced a monorepo architecture with five packages, a standalone CLI, and several new capabilities. All existing OpenClaw installations continue to work without modification.

### What Changed

The repository was reorganized from a single package into a monorepo:

```
packages/
  core/              — Framework-agnostic engine (no OpenClaw imports)
  cli/               — Standalone CLI binary (15+ commands)
  server/            — Standalone HTTP/MCP server
  bench/             — Benchmarks + CI regression gates
  hermes-provider/   — HTTP client for remote Engram instances
```

New capabilities added across milestones M0-M7:

| Area | What's New |
|------|-----------|
| Schema validation | Zod-validated request/response schemas on all endpoints |
| Structured errors | Consistent JSON errors with correlation IDs |
| Hermes provider | Standalone HTTP client for remote Engram instances |
| Standalone CLI | 15+ commands for init, status, query, doctor, daemon, onboard, curate, review, sync, dedup, connectors, space, benchmark |
| Onboarding | Language detection, doc discovery, ingestion planning |
| Curation | Deliberate ingestion with dedup/contradiction detection |
| Review inbox | Low-confidence item governance |
| Diff-aware sync | Source change detection with incremental ingestion |
| Dedup | Duplicate memory detection |
| Connectors | Host adapter registry with lifecycle management |
| Spaces | Personal, project, and team memory spaces |
| Benchmarks | Latency ladder with tier breakdowns and CI regression gates |
| Retrieval tiers | Tier 0 (exact) through Tier 4 (full scan) |

### What Stayed the Same

These integration points are unchanged -- auto-update is safe:

- **npm entry point**: `dist/index.js` -- identical behavior and exports
- **Config format**: `openclaw.json` under `plugins.entries.openclaw-engram.config` -- same schema
- **Plugin manifest**: `openclaw.plugin.json` -- still loaded by OpenClaw gateway
- **Memory storage**: `~/.openclaw/workspace/memory/local/` -- same file layout
- **All 60+ config options**: Unchanged with same defaults
- **Extraction/recall pipeline**: Identical behavior

### New Standalone Packages

| Package | Description |
|---------|-------------|
| `@engram/core` | Framework-agnostic engine with zero OpenClaw imports |
| `@engram/cli` | Standalone CLI binary with 15+ commands |
| `@engram/server` | Standalone HTTP/MCP server |
| `@engram/bench` | Benchmarks + CI regression gates |
| `@engram/hermes-provider` | HTTP client for remote Engram instances |

### New CLI Commands

The standalone `engram` CLI provides these commands:

| Command | Description |
|---------|-------------|
| `engram init` | Create `engram.config.json` in the current directory |
| `engram status [--json]` | Show server/daemon status |
| `engram query <text> [--explain]` | Query memories with optional tier breakdown |
| `engram doctor` | Run diagnostics (Node version, config, API key, memory dir, daemon) |
| `engram config` | Show current configuration |
| `engram daemon start\|stop\|restart` | Manage background server |
| `engram tree generate\|watch\|validate` | Context tree generation *(stub — not yet implemented)* |
| `engram onboard [dir]` | Onboard project directory |
| `engram curate <path>` | Curate files into memory |
| `engram review list\|approve\|dismiss\|flag` | Review inbox management |
| `engram sync run\|watch` | Diff-aware filesystem sync |
| `engram dedup` | Find duplicate memories |
| `engram connectors list\|install\|remove\|doctor` | Host adapter management |
| `engram space list\|switch\|create\|delete\|push\|pull\|share\|promote\|audit` | Memory space management |
| `engram benchmark run\|check\|report` | Latency benchmarks and regression gates |

### Verification Steps

**OpenClaw users:**

```bash
openclaw engram doctor --json    # Health diagnostics
npm test                         # 672 tests should pass
openclaw engram config-review    # Config tuning check
```

**Standalone users:**

```bash
engram doctor                    # Run diagnostics
engram status                    # Server status
engram query "test" --explain    # Verify query with tier breakdown
```

### Full Migration Guide

For comprehensive details, including adoption paths for each standalone feature and rollback instructions, see the [Platform Migration Guide](platform-migration.md).

---

## Operator Migration Checklist

- Replace copied preset JSON blocks with `memoryOsPreset` where possible.
- Update any docs that still point contributors at a specific plan file as if it were the live roadmap.
- Re-run config contract checks after adding or removing advanced fields.
- For v9.1.36+ platform migration: see the [Platform Migration Guide](platform-migration.md) for full details.
