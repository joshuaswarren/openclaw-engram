# BugBot Review Context — Remnic

## Project Overview

Remnic is a local-first memory plugin (TypeScript monorepo, pnpm workspaces, ESM-only, strict mode). The core package (`packages/remnic-core`) implements a three-phase memory lifecycle: recall, buffer, extract. It integrates with host platforms via hooks and registered tools.

## Critical Rules (block on violation)

### OpenAI API usage
- **MUST use the Responses API** — never `chat.completions.create`. Use `zodTextFormat()` for structured output. See `packages/remnic-core/src/extraction.ts` for the canonical pattern.
- **NEVER hard-code model names** — use `src/model-registry.ts`.

### Config schema alignment
- Every new config property MUST be added to BOTH `src/config.ts` (interface + defaults) AND `openclaw.plugin.json:configSchema`.
- Zod optional fields: use `.optional().nullable()`, not just `.optional()`.
- Config schema minimums must honor documented disable values (if docs say "0 to disable", `Math.max(1, value)` is wrong).

### Privacy (PUBLIC REPO)
- NEVER commit personal data, API keys, tokens, secrets, user memory content, or real conversation data.
- Paths containing user data (`facts/`, `entities/`, `corrections/`, `questions/`, `state/`, `profile.md`, `IDENTITY.md`) must never be committed.
- Test data must be synthetic. Config examples use placeholders like `${OPENAI_API_KEY}`.

### Import hygiene
- Import via package name: `import { X } from "@remnic/core"`, NOT relative cross-package paths like `import { X } from "../../../remnic-core/src/foo.js"`.
- Core package files must never have host-specific prefixes (e.g., no `openclaw-` prefix in `@remnic/core`).

## High-Priority Review Areas

### JavaScript/TypeScript traps
- **`slice(-0)` returns the full array** — guard `if (n <= 0)` before `slice(-n)`.
- **`"false"` is truthy** — coerce boolean-like strings at config-read boundaries.
- **`JSON.parse('null')` succeeds** — validate `typeof result === 'object' && result !== null`.
- **`existsSync` returns true for files** — use `statSync().isDirectory()` when a directory is expected.
- **Sort comparators must return 0 for equals** — use stable secondary keys. Never return 1 for both `compare(a,b)` and `compare(b,a)`.
- **`Object.entries` key order** — sort keys before hashing/serializing for dedup operations.
- **Serialized promise chains** — `writeChain.then(fn)` without `.catch()` recovery permanently poisons the chain after first error.

### File I/O safety
- **Never delete before write** — `rmSync` then `renameSync` loses data if rename fails. Write to temp, then atomic rename.
- **Write rollback before success markers** — if writing `.migrated-from-engram`, the `.rollback.json` must exist first.
- **Node.js does NOT expand `~`** — use `expandTilde()` for all user-facing path inputs.

### Dedup & indexing
- **Don't index content that failed to persist** — phantom index entries suppress legitimate retries.
- **Hash operations use consistent content form** — if writes hash `rawContent`, reads must too, not `citedContent`.
- **Cache invalidation must clear ALL layers** — grep all invalidation functions when adding a cache layer.

### Status & enum defaults
- **Enum defaults must be least-privileged** — default to `"disabled"`, `"pending"`, `"rejected"`, `"none"`, never `"enabled"` or `"approved"`.
- **Status filters must enumerate ALL non-active states** — define an explicit `ACTIVE_STATUSES` set, not ad-hoc exclusion lists.
- **Time-range filters use exclusive upper bounds** — `ts < toMs`, not `ts <= toMs` (half-open `[start, end)`).

### Validation
- **Reject invalid input** — invalid `--format`, `--since`, `--focus`, MCP params must throw errors listing valid options. Never silently default.
- **Validation allow-lists must match handled values** — if `ALLOWED` includes `"text"` but code only handles `"markdown"`, that's a bug.
- **CLI values need type coercion** — `--config port=5555` produces `"5555"` (string). Always `Number()` at boundary.

### Concurrency & isolation
- **Shared mutable objects must not leak across sessions** — per-connection instances or deep-copy for `clientInfo` etc.
- **Feature gates must be identical across all code paths** — if a gate covers the QMD path but not the fallback path, behavior diverges.

## Medium-Priority Checks

- **Wrap external service calls in try-catch** — token generation, daemon probes, filesystem writes must not crash primary flows.
- **Expand `~` in all user-facing path inputs** — `expandTilde()`, never ad-hoc regex.
- **Direct-write paths must trigger reindex** — heartbeat imports etc. must call reindex after writing.
- **Force-flush must bypass dedupe** — `skipDedupeCheck: true` for session flush and `before_reset`.
- **New filters/transforms need config gates** — `enabled` check or escape hatch, never unconditional.
- **Test mock signatures must match production interfaces** — mismatched mocks pass vacuously.
- **Distinguish empty results from failures** — `{ok: true, results: []}` vs `{ok: false, error: "..."}`.
- **Deduplicate batch operation inputs** — check for duplicates before processing batch renames.

## What NOT to Flag

- Build output in `dist/` — generated, not reviewed.
- Lock file changes (`pnpm-lock.yaml`) — dependency updates, not logic.
- Changelog entries or version bumps — auto-generated by changesets.
- Test fixture data in `tests/fixtures/` — intentionally static.
- Eval benchmark code in `evals/` — separate concern from core logic.
- Docs formatting changes — only flag if they misrepresent behavior.

## Monorepo Structure

```
packages/
  remnic-core/src/     — Core engine (161 source files)
  remnic-cli/           — CLI interface
  remnic-server/        — HTTP server
  plugin-claude-code/   — Claude Code plugin adapter
  plugin-codex/         — Codex plugin adapter
  plugin-openclaw/      — OpenClaw plugin adapter
  plugin-hermes/        — Hermes Python plugin
  bench/                — Benchmark harness
  shim-openclaw-engram/ — Legacy compatibility shim
```
