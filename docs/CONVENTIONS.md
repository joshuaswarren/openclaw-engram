# Development Conventions

Conventions and patterns used throughout the openclaw-engram codebase.

## TypeScript

- **Strict mode** — `tsconfig.json` has `"strict": true`. All code must pass `tsc --noEmit` without errors.
- **ESM only** — the package is `"type": "module"`. Use `import`/`export`; no `require()`.
- **Explicit return types** — all exported functions must have explicit return type annotations.
- **No `any`** — use `unknown` and narrow, or define a proper interface.
- **Optional fields** — when building Zod schemas for the OpenAI Responses API, use `.optional().nullable()`, not just `.optional()`.

## OpenAI Usage

- **Always use the Responses API** — never Chat Completions. See `src/extraction.ts` for the pattern.
- **Structured outputs** — use `zodTextFormat()` to get typed responses.
- **Model references** — never hard-code model names; use `src/model-registry.ts`.
- **Token logging** — log total tokens and latency; never log user prompt content.

## File Organization

- One logical unit per file where practical.
- `src/types.ts` is the single source of truth for shared interfaces.
- `src/config.ts` owns all config parsing and defaults.
- New subsystems must register their config properties in `openclaw.plugin.json:configSchema`.

## Memory Storage

- All memory files use markdown + YAML frontmatter.
- IDs follow the format `{category}-{timestamp}-{4-char-random}`.
- Status field must be one of: `active`, `superseded`, `expired`, `archived`.
- Paths that contain user data (`facts/`, `entities/`, `profile.md`, etc.) must never be committed to git.

## Testing

- Tests live in `tests/` and use Node.js's built-in `node:test` runner.
- Run with `npm test` (executes `tsx --test` against all `tests/*.test.ts` files).
- All tests must be deterministic — no network calls, no filesystem writes to real paths.
- Use `tests/transfer-fixtures.ts` patterns for shared test data.
- New subsystems require tests for: happy path, zero/empty input, and boundary conditions.

## Commit Style

- Follow Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Reference relevant invariant numbers from `AGENTS.md` when fixing guardrail violations.
- Never commit personal data, API keys, or memory content (see `CLAUDE.md`).

## Adding a New Config Property

1. Add to the interface in `src/config.ts` with a default.
2. Add to `openclaw.plugin.json:configSchema` with type and description.
3. Run `npm run check-config-contract` to verify alignment.
4. Document in `docs/config-reference.md`.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run lint` | Type-check without emitting (`tsc --noEmit`) |
| `npm test` | Run full test suite |
| `npm run preflight` | Full pre-PR gate (types + contract + tests + build) |
| `npm run preflight:quick` | Fast gate (types + contract + key tests) |
| `npm run check-config-contract` | Verify config types match plugin manifest |
