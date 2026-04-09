---
"@engram/core": major
"@engram/server": major
"@engram/cli": major
"@engram/hermes-provider": major
"openclaw-engram": patch
---

Initial 1.0.0 release of Engram workspace packages as standalone npm packages.

- `@engram/core` 1.0.0: Framework-agnostic memory engine with multi-token auth, cached token loading
- `@engram/server` 1.0.0: Standalone HTTP/MCP server with daemon lifecycle support
- `@engram/cli` 1.0.0: CLI with daemon management (launchd/systemd), connector install, token management
- `@engram/hermes-provider` 1.0.0: TypeScript HTTP client for Engram API
- `openclaw-engram`: Bridge mode (embedded/delegate), ENGRAM_CONFIG_PATH support
- `remnic-hermes` on PyPI: Python MemoryProvider for Hermes Agent
- Native plugins for Claude Code and Codex CLI (installed via `engram connectors install`)
