# Monorepo Structure

## Package Map

```
openclaw-engram/
├── packages/
│   ├── engram-core/          @remnic/core          Memory engine (0 internal deps)
│   ├── engram-server/        @remnic/server         HTTP + MCP server
│   ├── engram-cli/           engram                 CLI binary (daemon, connectors, tokens)
│   ├── plugin-openclaw/      openclaw-engram        OEO bridge (backward-compat npm name)
│   ├── plugin-claude-code/   @remnic/plugin-claude-code    Claude Code native plugin
│   ├── plugin-codex/         @remnic/plugin-codex          Codex CLI native plugin
│   ├── plugin-hermes/        remnic-hermes (PyPI)   Hermes MemoryProvider (Python)
│   ├── connector-replit/     @remnic/replit          Replit MCP connector
│   └── bench/                @remnic/bench           Benchmarks
├── src/                      Compatibility shims (re-exports from @remnic/core)
├── tests/                    Cross-package integration tests
├── docs/                     All documentation
└── evals/                    Evaluation harness
```

## Dependency Graph

```
@remnic/core ← no internal deps, no OpenClaw imports
│
├── @remnic/server ← depends on core
├── @remnic/cli ← depends on core, server
├── @remnic/bench ← depends on core
├── openclaw-engram ← depends on core
├── @remnic/plugin-claude-code ← depends on core (installer only)
├── @remnic/plugin-codex ← depends on core (installer only)
└── @remnic/replit ← depends on core (installer only)

@remnic/hermes-provider ← standalone TS HTTP client (0 internal deps)
remnic-hermes (Python) ← standalone, HTTP to EMO (0 internal deps)
```

## Build Order

Turborepo handles this automatically via `turbo.json`:

1. `@remnic/core` (foundation — everything depends on this)
2. `@remnic/server`, `openclaw-engram`, `@remnic/bench` (depend on core)
3. `@remnic/cli` (depends on core + server)
4. `@remnic/plugin-claude-code`, `@remnic/plugin-codex`, `@remnic/replit` (depend on core for installers)
5. `remnic-hermes` (Python — separate build pipeline)

## Package Details

### @remnic/core

The memory engine. Contains the Orchestrator, StorageManager, ExtractionEngine, all search backends, trust zones, namespace isolation, LCM, entity graph, compounding, shared context, work layer, and all supporting modules.

**Zero OpenClaw imports.** Can be used by any host.

### @remnic/server

Standalone HTTP + MCP server. Wraps `@remnic/core` with `EngramAccessService`, `EngramAccessHttpServer`, and `EngramMcpServer`. Includes adapter registry for client identity resolution.

### @remnic/cli (engram)

CLI binary providing:
- `engram daemon install|uninstall|start|stop|status` — daemon lifecycle
- `engram connectors install|remove|doctor|list` — plugin management
- `engram token generate|list|revoke` — auth token management
- `engram init|status|query|doctor|config` — setup and diagnostics
- `engram onboard|curate|review|sync|dedup` — memory operations
- `engram spaces|tree|bench` — workspace and benchmarking

### openclaw-engram (plugin-openclaw)

OEO bridge plugin. Publishes as `openclaw-engram` on npm for backward compatibility with OpenClaw's plugin loader. Depends on `@remnic/core`. Supports embedded and delegate modes.

### @remnic/plugin-claude-code

Native Claude Code plugin. Contains:
- `.claude-plugin/plugin.json` — plugin manifest
- `hooks/` — SessionStart, PostToolUse, UserPromptSubmit hooks
- `skills/` — `/engram:remember`, `/engram:recall`, etc.
- `agents/` — memory review agent
- `.mcp.json` — MCP server pointing to EMO

### @remnic/plugin-codex

Native Codex CLI plugin. Contains:
- `.codex-plugin/plugin.json` — plugin manifest
- `hooks/` — SessionStart, PostToolUse, UserPromptSubmit, Stop hooks
- `skills/` — memory workflow instructions
- `.mcp.json` — MCP server pointing to EMO

### remnic-hermes (Python)

Hermes MemoryProvider plugin. Distributed via PyPI. Implements the Hermes v0.7.0+ MemoryProvider protocol:
- `pre_llm_call` — inject recalled memories every turn
- `sync_turn` — observe conversation every turn
- `extract_memories` — structured extraction on session end
- Also registers explicit tools (recall, store, search)

### @remnic/replit

Replit MCP connector. Minimal package — setup instructions, config template, and installer that generates a token.

### @remnic/bench

Retrieval latency benchmarks and CI regression gates.

## Workspace Configuration

**pnpm-workspace.yaml:**
```yaml
packages:
  - "packages/*"
```

**turbo.json:**
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "check-types": {}
  }
}
```

## Compatibility Shims

After the core extraction, root `src/` contains one-line re-exports:

```typescript
// src/orchestrator.ts
export * from "@remnic/core/orchestrator";
```

These ensure:
- Existing tests in root `tests/` keep working during migration
- The root `tsup.config.ts` build still produces a valid `dist/index.js`
- Any external code importing from the root package isn't broken

Shims are removed once all consumers migrate to `@remnic/core`.
