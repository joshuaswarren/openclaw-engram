# Tech Stack

## Runtime

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js ≥ 22.12.0 | ESM modules (`"type": "module"`) |
| Language | TypeScript 5.x | Strict mode; compiled with `tsup` |
| Build | [tsup](https://tsup.egoist.dev/) | Bundles to `dist/` for distribution |

## Core Dependencies

| Package | Purpose |
|---------|---------|
| `openai ^6` | LLM extraction/consolidation via OpenAI Responses API |
| `zod ^3` | Runtime schema validation for structured LLM outputs |
| `@sinclair/typebox ^0.34` | JSON Schema generation for plugin config contract |
| `better-sqlite3 ^12` | Embedded SQLite for artifact cache and indexes |
| `@honcho-ai/sdk ^2` | Optional Honcho-AI integration for shared context |

## Dev Dependencies

| Package | Purpose |
|---------|---------|
| `tsx ^4` | Run TypeScript files directly (tests, scripts) |
| `tsup ^8` | Build and bundle TypeScript |
| `typescript ^5.9` | Type checking; `tsc --noEmit` for lint |

## External Tools (not npm packages)

| Tool | Purpose | Required? |
|------|---------|-----------|
| [QMD](https://github.com/tobi/qmd) | Hybrid BM25 + vector search | Recommended; graceful fallback |
| OpenAI API | LLM extraction and consolidation | Required for extraction |

## Test Infrastructure

Tests use Node.js's built-in test runner (`node:test`) executed via `tsx --test`.
No additional test framework is needed — import `node:test` and `node:assert` directly.

## CI

GitHub Actions (`.github/workflows/`) runs `npm run check-types`, `npm run test`, and `npm run build` on every push and pull request.
