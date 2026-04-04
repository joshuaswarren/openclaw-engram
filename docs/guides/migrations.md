# Migrations Guide

## Platform Migration (v9.1.36+)

The v9.1.36 release reorganizes Engram into a monorepo with five packages (`@engram/core`, `@engram/cli`, `@engram/server`, `@engram/bench`, `@engram/hermes-provider`) and adds a standalone CLI, spaces, benchmarks, onboarding, curation, diff-aware sync, connector management, and a retrieval tier system.

**For most OpenClaw users, the upgrade is transparent** -- the npm entry point, config format, plugin manifest, memory storage, and all 60+ config options are unchanged.

**Full guide:** [Platform Migration Guide](platform-migration.md)

**Quick verification:**

```bash
openclaw engram doctor --json   # OpenClaw users
engram doctor                    # standalone users
npm test                         # 672 tests pass
```

**Rollback:** `openclaw plugins install @joshuaswarren/openclaw-engram@<previous-version> --pin`

---

This guide also covers:

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

## Operator Migration Checklist

- Replace copied preset JSON blocks with `memoryOsPreset` where possible.
- Update any docs that still point contributors at a specific plan file as if it were the live roadmap.
- Re-run config contract checks after adding or removing advanced fields.
