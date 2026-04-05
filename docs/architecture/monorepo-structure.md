# Monorepo Structure

## Package Map

```
openclaw-engram/
├── packages/
│   ├── engram-core/          @engram/core          Memory engine (0 internal deps)
│   ├── engram-server/        @engram/server         HTTP + MCP server
│   ├── engram-cli/           engram                 CLI binary (daemon, connectors, tokens)
│   ├── plugin-openclaw/      openclaw-engram        OEO bridge (backward-compat npm name)
│   ├── plugin-claude-code/   @engram/plugin-claude-code    Claude Code native plugin
│   ├── plugin-codex/         @engram/plugin-codex          Codex CLI native plugin
│   ├── plugin-hermes/        engram-hermes (PyPI)   Hermes MemoryProvider (Python)
│   ├── connector-replit/     @engram/replit          Replit MCP connector
│   └── bench/                @engram/bench           Benchmarks
├── src/                      Compatibility shims (re-exports from @engram/core)
├── tests/                    Cross-package integration tests
├── docs/                     All documentation
└── evals/                    Evaluation harness
```

## Dependency Graph

```
@engram/core ← no internal deps, no OpenClaw imports
│
├── @engram/server ← depends on core
├── @engram/cli ← depends on core, server
├── @engram/bench ← depends on core
├── openclaw-engram ← depends on core
├── @engram/plugin-claude-code ← depends on core (installer only)
├── @engram/plugin-codex ← depends on core (installer only)
└── @engram/replit ← depends on core (installer only)

@engram/hermes-provider ← standalone TS HTTP client (0 internal deps)
engram-hermes (Python) ← standalone, HTTP to EMO (0 internal deps)
```

## Build Order

Turborepo handles this automatically via `turbo.json`:

1. `@engram/core` (foundation — everything depends on this)
2. `@engram/server`, `openclaw-engram`, `@engram/bench` (depend on core)
3. `@engram/cli` (depends on core + server)
4. `@engram/plugin-claude-code`, `@engram/plugin-codex`, `@engram/replit` (depend on core for installers)
5. `engram-hermes` (Python — separate build pipeline)

## Package Details

### @engram/core

The memory engine. Contains the Orchestrator, StorageManager, ExtractionEngine, all search backends, trust zones, namespace isolation, LCM, entity graph, compounding, shared context, work layer, and all supporting modules.

**Zero OpenClaw imports.** Can be used by any host.

### @engram/server

Standalone HTTP + MCP server. Wraps `@engram/core` with `EngramAccessService`, `EngramAccessHttpServer`, and `EngramMcpServer`. Includes adapter registry for client identity resolution.

### @engram/cli (engram)

CLI binary providing:
- `engram daemon install|uninstall|start|stop|status` — daemon lifecycle
- `engram connectors install|remove|doctor|list` — plugin management
- `engram token generate|list|revoke` — auth token management
- `engram init|status|query|doctor|config` — setup and diagnostics
- `engram onboard|curate|review|sync|dedup` — memory operations
- `engram spaces|tree|bench` — workspace and benchmarking

### openclaw-engram (plugin-openclaw)

OEO bridge plugin. Publishes as `openclaw-engram` on npm for backward compatibility with OpenClaw's plugin loader. Depends on `@engram/core`. Supports embedded and delegate modes.

### @engram/plugin-claude-code

Native Claude Code plugin. Contains:
- `.claude-plugin/plugin.json` — plugin manifest
- `hooks/` — SessionStart, PostToolUse, UserPromptSubmit hooks
- `skills/` — `/engram:remember`, `/engram:recall`, etc.
- `agents/` — memory review agent
- `.mcp.json` — MCP server pointing to EMO

### @engram/plugin-codex

Native Codex CLI plugin. Contains:
- `.codex-plugin/plugin.json` — plugin manifest
- `hooks/` — SessionStart, PostToolUse, UserPromptSubmit, Stop hooks
- `skills/` — memory workflow instructions
- `.mcp.json` — MCP server pointing to EMO

### engram-hermes (Python)

Hermes MemoryProvider plugin. Distributed via PyPI. Implements the Hermes v0.7.0+ MemoryProvider protocol:
- `pre_llm_call` — inject recalled memories every turn
- `sync_turn` — observe conversation every turn
- `extract_memories` — structured extraction on session end
- Also registers explicit tools (recall, store, search)

### @engram/replit

Replit MCP connector. Minimal package — setup instructions, config template, and installer that generates a token.

### @engram/bench

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
export * from "@engram/core/orchestrator";
```

These ensure:
- Existing tests in root `tests/` keep working during migration
- The root `tsup.config.ts` build still produces a valid `dist/index.js`
- Any external code importing from the root package isn't broken

Shims are removed once all consumers migrate to `@engram/core`.
