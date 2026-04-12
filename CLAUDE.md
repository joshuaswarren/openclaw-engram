# remnic

## PUBLIC REPOSITORY — Privacy Policy

**This repository is PUBLIC on GitHub.** Every commit is visible to the world.

### Rules for ALL agents committing to this repo:

1. **NEVER commit personal data** — no names, emails, addresses, phone numbers, account IDs, or user identifiers
2. **NEVER commit API keys, tokens, or secrets** — even in comments or examples
3. **NEVER commit memory content** — the `facts/`, `entities/`, `corrections/`, `questions/`, `state/` directories contain user memories and must NEVER be committed
4. **NEVER commit IDENTITY.md or profile.md** — these contain personal behavioral profiles
5. **NEVER commit `.env` files** or any file containing credentials
6. **NEVER reference specific users, their preferences, or their data** in code comments or commit messages
7. **Config examples must use placeholders** — `${OPENAI_API_KEY}`, not actual keys
8. **Test data must be synthetic** — never use real conversation data in tests

### What IS safe to commit:
- Source code (`src/`, `scripts/`)
- Package manifests (`package.json`, `tsconfig.json`, `tsup.config.ts`)
- Plugin manifest (`openclaw.plugin.json`)
- Documentation (`README.md`)
- Build configuration
- `.gitignore`
- This `CLAUDE.md` file

### Before every commit, verify:
- `git diff --cached` contains NO personal information
- No hardcoded API keys, URLs with tokens, or credentials
- No references to specific users or their data

## Architecture Notes

### File Structure
```
src/
├── index.ts              # Plugin entry point, hook registration
├── config.ts             # Config parsing with defaults
├── types.ts              # TypeScript interfaces
├── logger.ts             # Logging wrapper
├── orchestrator.ts       # Core memory coordination
├── storage.ts            # File I/O for memories
├── buffer.ts             # Smart turn buffering
├── extraction.ts         # GPT-5.2 extraction engine
├── qmd.ts                # QMD search client
├── importance.ts         # Importance scoring
├── chunking.ts           # Large content chunking
├── threading.ts          # Conversation threading
├── topics.ts             # Topic extraction
├── tools.ts              # Agent tools
└── cli.ts                # CLI commands
```

### Key Patterns

1. **Three-phase flow** — recall (before), buffer (after), extract (periodic)
2. **Smart buffer** — decides when to flush based on content signals
3. **GPT-5.2 for extraction** — uses OpenAI Responses API (NOT Chat Completions)
4. **QMD for search** — hybrid BM25 + vector + reranking
5. **Markdown + YAML frontmatter** — human-readable storage format
6. **Consolidation** — periodic merging, cleaning, and summarization

### Integration Points

- `api.on("gateway_start")` — initialize orchestrator
- `api.on("before_agent_start")` — inject memory context
- `api.on("agent_end")` — buffer turn for extraction
- `api.registerTool()` — memory search, stats, etc.
- `api.registerCommand()` — CLI interface
- `api.registerService()` — service lifecycle

### Testing Locally

```bash
# Build
npm run build

# Full restart (gateway_start hook needs this)
launchctl kickstart -k gui/501/ai.openclaw.gateway

# Or for hot reload (but gateway_start won't fire)
kill -USR1 $(pgrep openclaw-gateway)

# Trigger a conversation to test

# View logs
grep "\[engram\]" ~/.openclaw/logs/gateway.log
```

### Common Gotchas

1. **OpenAI must use Responses API** — never Chat Completions (per CLAUDE.md guidelines)
2. **Zod optional fields** — must use `.optional().nullable()`, not just `.optional()`
3. **Gateway launchd env isolated** — API keys must be in plist EnvironmentVariables
4. **Config schema strict** — new properties MUST be added to `openclaw.plugin.json` configSchema
5. **SIGUSR1 doesn't fire gateway_start** — use `launchctl kickstart -k` for full restart
6. **profile.md injected everywhere** — keep under 600 lines or consolidation triggers
7. **QMD `query` is intentional** — DO NOT change from `query` to `search` or `vsearch`. The `query` command provides LLM expansion + reranking that Remnic relies on. Remnic's own reranking was disabled because `qmd query` handles it.
8. **QMD local patches** — PRs #166, #112, #117 are applied locally to `~/.bun/install/global/node_modules/qmd/`. These will be overwritten by `bun install -g github:tobi/qmd` — reapply if needed until merged upstream.
9. **Legacy env var fallback chains** — always try `REMNIC_*` first, then fall back to `ENGRAM_*`. This applies to config parsing, hook scripts, and daemon label lookups.
10. **Never interpolate unsanitized values into shell scripts** — pass host/port/config values via environment variables, never via string interpolation into script command strings.
11. **Scope globals per plugin ID** — runtime orchestrator mirrors, CLI dedupe guards, and capability caches must be keyed by `serviceId` when multiple instances can coexist.
12. **Write rollback data before success markers** — if a migration writes `.migrated-from-engram`, the `.rollback.json` must be written first so failures don't leave a false success marker.
13. **Wrap external service calls in try-catch** — token generation, daemon health probes, and filesystem writes must not crash the primary install/remove/config flow. Fail gracefully and surface a user-facing note instead.
14. **Validate CLI flag arguments exist** — `--format`, `--focus`, `--since` without a following value must throw an error, not silently default.
15. **Sync lock files after dependency changes** — changing `workspace:*` specifiers or adding/removing packages requires `pnpm install` to update `pnpm-lock.yaml` and any nested `package-lock.json` files.
16. **Clean up ALL test globals in teardown** — include unkeyed globals like `__openclawEngramOrchestrator` in `resetGlobals()` helpers, not just the keyed ones.
17. **Expand `~` in all user-facing path inputs** — Node.js `fs` does NOT expand `~`. Use `expandTilde()` consistently, never ad-hoc regex. This applies to `memoryDir`, `--config`, env var paths, and `--memory-dir`.
18. **Validate JSON parse result type** — `JSON.parse('null')` succeeds but `null` is not a valid config. Always check `typeof result === 'object' && result !== null` after parsing before property access.
19. **Sort comparators must return 0 for equal items** — a comparator that returns `1` for both `compare(a,b)` and `compare(b,a)` violates the contract and produces non-deterministic ordering. Use a stable secondary key.
20. **Search ALL code when changing function signatures** — when changing `addTurn(role, content)` to `addTurn(sessionId, turn)`, search `evals/`, `tests/`, and `packages/*/` — not just `src/`. Missed call sites in adapters/evals were a recurring source of post-merge fixes.
21. **Interactive prompts must gate actual mutations** — if a migration prompt asks "migrate legacy config?" and the user says "no", the code must skip the actual config mutations, not just print different console messages while still writing the new config.
22. **Config resolution must be deduplicated** — the slot → PLUGIN_ID → LEGACY_PLUGIN_ID resolution was independently implemented in 5+ locations with divergent edge-case handling. Always import from the shared utility rather than reimplementing.
23. **Hash operations must use consistent content form** — if writes hash `rawContent`, reads and dedup checks must also hash `rawContent`, not the timestamped `citedContent`. Mixing forms silently breaks dedup.
24. **Reject file paths used as directory arguments** — `existsSync` returns true for files. Use `statSync().isDirectory()` when a directory is expected. Accepting a file as `memoryDir` produces a broken install that only fails later.
25. **Don't destroy old state before confirming new state succeeds** — rotate tokens AFTER config write succeeds, clean up old profiles AFTER new profile is confirmed. PR #400 had 20+ review rounds on this pattern alone.
26. **Import via package name, not relative cross-package paths** — `import { X } from "@remnic/core"` not `import { X } from "../../../remnic-core/src/foo.js"`. Directory renames silently break relative imports with no package-dependency signal.
27. **Guard `slice(-n)` against `n === 0`** — `entries.slice(-0)` equals `slice(0)` and returns ALL entries. Always check `if (n <= 0)` before negating for slice. The `-0 === 0` footgun is a JavaScript-specific trap.
28. **Coerce CLI values to expected types at input boundaries** — `--config port=5555` produces `"5555"` (string). `typeof saved === "number"` rejects it on reinstall. Always `Number(port)` + validate at the boundary, store as the expected type.
29. **Force-flush must bypass dedupe** — explicit flush surfaces (session flush, before_reset) must pass `skipDedupeCheck: true`. Stale dedup fingerprints from failed extractions suppress legitimate retries.
30. **New filters/transforms must have configuration gates** — every new recall filter, config transformation, or behavioral override needs an `enabled` check or escape hatch. Unconditional changes remove user control and break feature-flag symmetry.
31. **Core package files must never have host-specific prefixes** — `openclaw-recall-audit.ts` in `@remnic/core` violates the architecture boundary. Generic modules in core should use generic names (`recall-audit.ts`). Host adapters wrap core, not the other way around.
32. **Line parsers must track position during iteration, not use indexOf** — `content.indexOf(line)` returns the first occurrence, not the current parsing position. When parsing structured text with potential duplicate lines, maintain a running offset variable.
33. **Test mock function signatures must match production interfaces** — if production declares `getLastRecall(sessionKey: string)`, the mock must accept and use `sessionKey`, not define a zero-argument function. Mismatched mocks make tests pass vacuously.
34. **Distinguish empty results from backend failures** — `search()` returning `[]` for both "index is empty" and "endpoint returned 5xx" prevents callers from short-circuiting on genuine failures. Use distinct result shapes: `{ok: true, results: []}` vs `{ok: false, error: "backend_unavailable"}`.
35. **Time-range filters must use exclusive upper bounds** — `ts <= toMs` causes double-counting at midnight boundaries. Use `ts < toMs` consistently for half-open `[start, end)` interval semantics. Test with exact-boundary timestamps.
36. **String `"false"` is truthy in JavaScript** — `--config installExtension=false` produces `"false"` (string), which `!== false` evaluates as `true`. Coerce boolean-like strings (`"false"`, `"0"`, `"no"`, `"off"`) at config-read boundaries using a shared helper.
37. **Cache invalidation must clear ALL cache layers** — if `invalidateAllMemoriesCache()` only clears the hot cache but not `coldMemoriesCache`, stale data persists. When adding a cache layer, grep all invalidation functions and update them.
38. **Sort object keys before hashing/serializing** — `Object.entries({city, country})` vs `Object.entries({country, city})` produce different strings, breaking deduplication. Sort keys before serializing for any hash/content-dedup operation.
39. **Feature gates must be identical across all code paths** — if `temporalSupersessionEnabled` gates the QMD path but not the recent-scan fallback path, behavioral divergence depends on which recall path is exercised. Enumerate every path when adding a feature gate.
40. **Serialized promise chains must recover from rejection** — `writeChain = writeChain.then(fn)` without `.catch()` recovery permanently poisons the chain after the first I/O error. All subsequent `.then()` callbacks never execute. Use a `queueWrite()` wrapper that recovers the chain after rejection while still surfacing the error to the caller.
41. **Match loop iterator method to the data you need** — `for (const v of map.values())` when you also need the key means referencing an undefined or outer-scope variable. Use `.entries()` to destructure both key and value. TypeScript strict mode should catch this, but verify `noImplicitAny` is enabled.
42. **Read and write paths must resolve through the same namespace layer** — if search uses namespace-aware resolution, get/delete must too. Un-namespaced search in multi-principal deployments exposes cross-tenant data. Constrain search scope via session-derived namespace resolution.
43. **Direct-write paths must trigger reindex** — bypassing the normal extraction→persist→index pipeline (e.g., heartbeat import writing directly to storage) leaves data undiscoverable until unrelated maintenance. After direct writes, explicitly call the reindex step.
44. **Don't index content that failed to persist** — if a dedup check, importance gate, or other filter rejects content before it's written to storage, do NOT add it to `contentHashIndex`. Phantom index entries cause subsequent extractions with similar content to be silently dedup-suppressed against non-existent stored facts. PR #399.
45. **Config schema minimums must honor documented disable values** — if docs say "set to 0 to disable", both the JSON schema `minimum` AND the code path must accept 0. `Math.max(1, value)` with `minimum: 1` in the schema silently overrides the user's documented disable intent. PR #399.
46. **Escape literal template parts before building regex** — when constructing regex from user-provided templates, always `escapeRegex()` on the prefix/suffix. Empty prefix+suffix produces a match-everything regex. Special `$` in replacement strings corrupts output — use a replacement function or escape `$` → `$$`. PR #401.
