# Remnic - Agent Guide

## Architecture Boundaries (Non-Negotiable)

Remnic is a multi-platform memory system. Keep these boundaries intact on every change:

1. `@remnic/core`, `@remnic/server`, and `@remnic/cli` own Remnic's core behavior.
   Core memory semantics, storage, retrieval, extraction, governance, and standalone operation must live there.
2. Core and standalone paths must not depend on OpenClaw, Hermes, or any future host.
   Host integrations may consume core. Core must not reach back into host SDKs, config shapes, or runtime lifecycles.
3. Platform-specific behavior belongs in platform adapters only.
   OpenClaw-specific code belongs in `packages/plugin-openclaw` plus the current root `src/` compatibility wiring that still hosts OpenClaw runtime entrypoints today. Hermes-specific code belongs in `packages/plugin-hermes`. Keep host logic thin and translation-focused.
4. Do not reinvent host-native features.
   If OpenClaw, Hermes, or another platform already provides a runtime capability, plugin hook, command surface, or extension primitive, use that real upstream contract instead of recreating a parallel Remnic abstraction.
5. Verify host behavior against current upstream source and docs before implementing it.
   Issue text, old local docs, or remembered APIs are not enough for host-facing work.

## Upstream References

Use these as the canonical starting points for adapter work:

- OpenClaw repository: <https://github.com/openclaw/openclaw>
- OpenClaw plugin docs: <https://github.com/openclaw/openclaw/tree/main/docs/plugins>
- OpenClaw SDK overview: <https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-overview.md>
- OpenClaw SDK entrypoints: <https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-entrypoints.md>
- Hermes Agent repository: <https://github.com/NousResearch/hermes-agent>
- Hermes Agent docs/site: <https://hermes-agent.nousresearch.com>

## Adapter Implementation Rules

- Start from the host's current upstream contracts, then adapt Remnic core into them.
- Reuse upstream platform primitives when they exist; only add Remnic-owned glue where the host does not already solve the problem.
- Keep standalone and shared-core behavior testable without booting OpenClaw, Hermes, or another host.
- If a change touches both core semantics and a host adapter, land the core contract first and make the adapter consume it second.

## Review Prevention Checklist (All Agents — Read Before Every PR)

These patterns were extracted from 50+ PRs across 2026-04-05 to 2026-04-12.
Every item below was caught by a reviewer (Cursor Bugbot, Codex, or CodeQL) and
required a follow-up commit to fix. Follow these rules to ship clean on the first push.

### 1. Input Validation — Reject Invalid Inputs Explicitly

Reviewers repeatedly caught silent defaulting on invalid inputs. Never silently
accept and reinterpret bad values.

- **CLI flags must validate their argument exists** — `--format json` where
  `--format` has no value must throw, not silently default.
- **Enum/config values must be validated against an explicit allow-list** — when
  adding a new accepted value (e.g., `"low"` for `activeRecallThinking`), add it
  to the validation schema AND the config parser.
- **Numeric inputs must be type-checked** — port values must be finite integers
  in [1, 65535]; reject `"abc"` and `3.7` rather than truncating.
- **Date/timestamp parsing must guard overflow** — reject inputs that would
  overflow `Date` bounds instead of producing `Invalid Date`.

### 2. Rename Completeness — Always Add Legacy Fallbacks

The Engram→Remnic rename touched every surface. Every rename PR required
follow-up fixes for missed references.

- **Search the entire codebase when renaming anything** — `grep -ri oldname`
  across all files including docs, tests, lock files, changesets, hooks, and
  CI configs.
- **Always add a legacy fallback chain** — env vars: `REMNIC_FOO` → `ENGRAM_FOO`;
  config keys: try `remnic` block first, fall back to `engram` block.
- **Update lock files when changing workspace dependencies** — changing
  `workspace:*` specifiers or package names without running `pnpm install`
  breaks the lock file.
- **Changeset files must reference current package names** — stale package IDs
  in `.changeset/` will cause release failures.
- **Hook scripts must use the current plugin name in error messages and paths.**

### 3. Security — Sanitize at System Boundaries

CodeQL and Bugbot repeatedly flagged these patterns.

- **Never interpolate unsanitized values into shell commands** — pass host/port
  via environment variables, never via string interpolation into script strings.
- **Restrict file permissions on auth tokens** — config files containing tokens
  should use `0600` permissions.
- **Block symlink traversal in directory scans** — when scanning `artifacts/` or
  memory directories, reject symlinks that resolve outside the allowed root.
  Reject symlinked root directories entirely.
- **Validate external inputs at system boundaries** — profile values, connector
  IDs, and config paths must be sanitized before filesystem operations.

### 4. Error Handling — Never Let Side Effects Crash the Main Flow

Token store failures, daemon unavailability, and filesystem errors must not
block the primary operation.

- **Wrap token/external-service operations in try-catch** — if `generateToken()`
  fails, the install should still complete with a note to run token generation
  manually later.
- **Write rollback manifests BEFORE migration markers** — if rollback metadata
  write fails, the system must not think migration succeeded.
- **Use AbortController for timeout-able async operations** — timed-out
  `before_reset` flushes must abort the in-flight extraction before buffer
  clearing, so late flushes cannot clear turns buffered after reset proceeds.
- **Guard refcount operations against double-decrement** — track whether
  increment happened before decrementing; use a `didCountStart` flag.

### 5. State Scoping — Don't Share What Shouldn't Be Shared

Multiple plugin instances can coexist; globals must be scoped.

- **Scope singletons per plugin ID** — runtime orchestrator mirrors, CLI dedupe
  guards, and capability caches must be keyed by `serviceId`, not stored as
  bare globals.
- **Scope extraction deduplication by session/buffer key** — `shouldQueueExtraction`
  must fingerprint `bufferKey + normalizedTurnText`, not just turn text, so
  parallel sessions don't suppress each other's extractions.
- **Cache writes and reads must use consistent formats** — if the hook path
  writes `{version, data}` and the section path reads `data` directly, they will
  diverge.

### 6. Test Quality — Tests Must Actually Verify Behavior

Reviewers caught multiple tests that passed vacuously.

- **Never write assertions on empty arrays** — `expect(result).toEqual([])` passes
  trivially; assert on non-empty expected data or assert the function was called.
- **Don't assume filesystem ordering** — `readdir` is not guaranteed to be
  alphabetical; sort explicitly before comparing.
- **Clean up ALL global state in test teardown** — including unkeyed globals
  like `__openclawEngramOrchestrator` mirror keys in `resetGlobals()`.
- **Test error paths** — for every `try/catch` added in production code, add a
  test that forces the error path and asserts recovery behavior.
- **Don't use fragile CWD-relative paths** — use `import.meta.dirname` or
  `path.resolve(__dirname, ...)` instead of assuming CWD.

### 7. Documentation Accuracy — Examples Must Be Copy-Pasteable

Every doc PR required follow-up fixes for stale references.

- **Code examples must reference current variable names** — after a rename,
  search all code blocks in docs for the old name.
- **CLI command examples must use current commands** — `remnic connectors install`,
  not `engram connectors install`.
- **Hook templates must use current env var chains** — match the real hook
  scripts' `REMNIC_* → ENGRAM_*` fallback precedence.
- **Architecture diagrams must use current labels** — "Remnic Orchestrator",
  not "Engram Orchestrator".

### 8. Dead Code — Remove What You Don't Need

Reviewers flagged unreachable branches and unused exports.

- **Remove unreachable branches** — if a non-recursive flag makes a branch
  unreachable, delete it rather than leaving dead code.
- **Don't duplicate helpers across packages** — if `toolJsonResult` exists in
  two tool files, extract to a shared utility.
- **Remove dead switch cases** — after normalizing tool names, remove the old
  case rather than leaving it to silently never match.

### 9. Config Resolution — Deduplicate Shared Lookup Logic

The slot-based config resolution pattern (`slot → PLUGIN_ID → LEGACY_PLUGIN_ID`)
was independently reimplemented in 5+ locations with divergent guard styles,
causing inconsistent behavior during migration.

- **Extract config resolution into a single shared module** — `resolveRemnicPluginEntry`
  must be the one source of truth; all callers (access-cli, operator-toolkit,
  materialize.cjs, src/index.ts) must import from it.
- **Validate that resolved plugin IDs belong to Remnic** — a foreign plugin's
  config can be read and applied to Remnic when `slots.memory` points elsewhere.
  Always check `resolvedId === PLUGIN_ID || resolvedId === LEGACY_PLUGIN_ID`.
- **Maintain legacy flat-config fallback** — developer-mode configs where the
  top-level object IS the plugin config must still resolve correctly.
- **Keep env var priority consistent** — primary `REMNIC_*` / `OPENCLAW_*`
  must be checked before legacy `ENGRAM_*` / `OPENCLAW_ENGRAM_*` everywhere.

### 10. Path Handling — Expand Tildes and Validate Types

Node.js `fs` functions do NOT expand `~`. Multiple PRs had path-related bugs.

- **Expand `~` consistently with `expandTilde`** — never use ad-hoc regex like
  `path.replace(/^~/, homedir())` which incorrectly matches `~user/` prefixes.
  Use the shared `expandTilde()` for all user-facing path inputs: `memoryDir`,
  `--config`, `OPENCLAW_CONFIG_PATH`, `--memory-dir`.
- **Validate path type before using** — `existsSync` returns true for files too;
  use `statSync().isDirectory()` when a directory is expected. Reject file paths
  used as `memoryDir`.
- **Fail fast on invalid JSON config** — when `openclaw.json` exists but cannot
  be parsed (or parses to `null` / non-object), surface an error instead of
  silently returning `{}` which then overwrites the file destroying all settings.
- **Validate `plugins.entries` shape** — check it's a plain object, not `null`,
  array, number, or string before using `in` operator or property access.

### 11. Signature Changes — Propagate to All Call Sites

Changing a function signature is a high-risk operation that consistently
required follow-up fixes.

- **Search ALL code including evals, tests, and adapters** — when changing
  `addTurn(role, content)` to `addTurn(sessionId, turn)`, search not just `src/`
  but `evals/`, `tests/`, and `packages/*/` for old-form call sites.
- **Add a deprecation path for public APIs** — if the function is exported,
  add a compatibility wrapper that maps old args to new with a deprecation log,
  rather than breaking silently.
- **Update test helpers to match production behavior** — if production code
  gates on a `migrateLegacy` flag, the test helper must read the same flag
  instead of unconditionally executing.

### 12. Sort Stability — Comparators Must Return 0 for Equal Items

Multiple sort comparators never returned `0`, causing non-deterministic
ordering that broke diffs and automation.

- **Sort comparators must be well-formed** — return `-1`, `0`, or `1`. Never
  return `1` for both orderings of equal items. When `a.updatedAt === b.updatedAt`,
  return `0` or use a stable secondary key (e.g., `id`).
- **Non-deterministic output breaks downstream** — top-N slices from unstable
  sorts produce different results across runs, making briefings, reports, and
  diffs unreliable.
- **Test sort stability explicitly** — sort a list with duplicate keys and
  assert the output is identical across multiple invocations.

### 13. Hash/Dedup Consistency — Use the Same Content Form Everywhere

When content is transformed before persistence (e.g., citation injection,
timestamp appending), hash operations must consistently use either raw or
transformed form — never a mix.

- **All hash-index operations must use the same content form** — if writes
  hash `rawContent`, reads and dedup checks must also hash `rawContent`, not
  `citedContent` (which includes timestamps).
- **Beware of double-hashing** — if `contentHashIndex.remove()` internally
  hashes its argument, passing an already-hashed value produces `hash(hash(x))`
  which never matches stored entries.
- **Don't mix `contentHashSource` and direct hashing** — if one write path
  passes `contentHashSource: rawContent` and another omits it (causing the
  index to hash the persisted form with timestamp), dedup breaks.

### 14. Atomic Multi-Step Operations — Don't Destroy Old State Before New State Is Confirmed

PR #400 had 20+ review rounds on connector lifecycle. The dominant pattern was
destroying valid state before confirming the replacement is viable.

- **Don't rotate/destroy tokens before confirming the new config write succeeds**
  — if `generateToken()` revokes the old token, then `upsertHermesConfig` or
  `commitTokenEntry` fails, the user is left with a revoked token and no working
  config. Always confirm the new state before destroying the old.
- **Don't clean up old profile config before new profile write succeeds** — if
  `removeHermesConfig(oldProfile)` runs before `upsertHermesConfig(newProfile)`
  succeeds, a partial failure leaves neither profile configured.
- **Persist rollback data BEFORE writing success markers** — if `.rollback.json`
  write fails, a `.migrated-from-engram` marker creates a false success signal.
- **Don't write connector JSON with a new token before confirming token store
  commit** — `connector.json` holding a token the daemon doesn't recognize
  creates an invisible auth mismatch.

### 15. Monorepo Package Boundaries — Never Reach Across `src/` Directories

Reviewers repeatedly flagged cross-package relative imports that bypass the
public export surface.

- **Import via package name, not relative path** — use
  `import { X } from "@remnic/core"` not
  `import { X } from "../../../remnic-core/src/foo.js"`. A directory rename or
  build-output change in the target package silently breaks the import.
- **Shim packages must own their runtime identity** — when a shim re-exports
  `pluginDefinition`, its `register()` must use its own `LEGACY_PLUGIN_ID`, not
  the inherited `PLUGIN_ID`. Module-level constants are captured at import time,
  not overridden by object-spread.
- **Config loaders must ALL agree on lookup semantics** — if `access-cli.ts`
  uses ternary+`??` fallback and `src/index.ts` uses early-return, they diverge
  during migration when both entries exist. One shared resolver, one pattern.

### 16. Config Guard Rails — New Features Must Be Gatable and Reversible

Reviewers caught features that unconditionally transformed behavior without any
escape hatch or configuration gate.

- **Add an `enabled` check or escape hatch for every new filter/transform** —
  if a new recall filter unconditionally removes `dream`/`procedural` memories,
  users can never search for them even when the feature is disabled. Mirror the
  pattern: lifecycle filters have `enabled` checks; new filters must too.
- **Force reinstall must merge from existing config** — when `--force` is used
  without re-supplying `--config profile=...`, hard-resetting to defaults
  silently loses the user's configured profile/host/port. Read the existing
  stored config first and merge.
- **Guard slot-based lookups against foreign plugin IDs** — if
  `plugins.slots.memory` points to a non-Remnic plugin, the lookup must reject
  it rather than silently applying a foreign plugin's settings to Remnic.
  Always validate `resolvedId === PLUGIN_ID || resolvedId === LEGACY_PLUGIN_ID`.

### 17. JavaScript Numeric Footguns — Guard Zero, Negative Zero, and Type Coercion at Boundaries

Multiple PRs had bugs from JavaScript's numeric quirks and CLI string→number
coercion issues.

- **Guard `slice(-maxEntries)` against `maxEntries === 0`** —
  `entries.slice(-Math.max(0, 0))` produces `slice(-0)` which equals `slice(0)`
  and returns ALL entries. Always check `if (maxEntries <= 0)` before negation.
- **CLI values arrive as strings** — `--config port=5555` produces `"5555"`,
  not `5555`. Type guards like `typeof prev?.port === "number"` reject saved
  values on reinstall. Always coerce at the input boundary with
  `Number(port)` + validation, then store as the expected type.
- **Reject non-integers explicitly** — `Number.isFinite(4318.9)` is true but
  silently truncating to a different port is a misconfiguration. Use
  `Number.isInteger()` when integers are expected.

### 18. Force-Flush and Dedupe — Explicit Operations Must Bypass Dedupe

Reviewers caught a critical bug where explicit flush operations (session flush,
before_reset) were suppressed by the same deduplication that guards automatic
extraction.

- **Explicit flushes must pass `skipDedupeCheck: true`** — if a prior
  extraction attempt failed/timed out but left the buffer intact, the
  dedupe fingerprint still exists. A subsequent force-flush must not be
  suppressed by stale dedup state.
- **Buffer key must be propagated through all extraction paths** — if
  `ingestReplayBatch` calls `queueBufferedExtraction` without `bufferKey`,
  the default `"default"` key is used, clearing the wrong buffer on success.
- **Don't health-check with uncommitted tokens** — if `commitTokenEntry`
  fails or is skipped, `checkDaemonHealth` sends an unknown token, gets 401,
  waits 6 seconds on retry, and reports a misleading "not reachable" message.

---

## What This Project Does (Simple Explanation)

Remnic gives AI agents long-term memory that persists across conversations.

## PR Hardening Rule (All Agents)

If you touch retrieval/planner/cache/config logic, you must run the hardening gate in:
`docs/ops/pr-review-hardening-playbook.md`

This is mandatory before claiming a PR is review-clean.

## Retrieval/Intent/Cache Guardrails (All Agents)

Treat these as non-negotiable engineering constraints for this plugin:

1. Recall pipeline order is a contract:
   - retrieve candidate headroom
   - apply policy filters (namespace/status/path/type)
   - rerank/boost
   - cap to user-facing budget
   - format and inject
   Never cap before final filtering for the section users consume.

2. Artifact isolation:
   Artifacts must flow only through the dedicated verbatim-artifact path.
   Generic QMD/embedding memory recall must exclude `artifacts/` paths.

3. Planner mode semantics:
   `no_recall`, `minimal`, `full`, and `graph_mode` are behavioral contracts.
   - each mode must be reachable
   - `no_recall` must gate all fallback paths
   - `minimal` must actually cap retrieval size

4. Config is runtime API:
   `enabled=false` and `0` limits are compatibility guarantees, not hints.
   Never coerce `0` to non-zero. Keep write-time/read-time behavior symmetric.

5. Intent heuristics must be morphology-aware and precedence-tested:
   Regex-based intent extraction must handle common conjugations/variants and avoid accidental mismatches.
   Add tests for representative natural language variants, not only base forms.

6. Cache invariants:
   - cache versions must be shared per memory directory when multiple instances can read/write
   - cache timestamps must reflect rebuild completion time
   - cache must persist negative lookups where useful (e.g., missing IDs) to avoid rebuild loops
   - concurrent writes during rebuild must not publish stale snapshots

7. Fallback parity:
   Any retrieval-policy rule applied in primary search must be mirrored in fallback search paths.

## Mandatory Test Updates For Subsystem Changes

If you change `src/orchestrator.ts`, `src/storage.ts`, or `src/intent.ts`, include/adjust tests for all impacted invariants:

- planner reachability and gating
- zero-limit semantics
- cap-after-filter behavior
- artifact-path isolation
- cache coherence across instances and concurrent writes
- heuristic variant coverage (intent phrases/conjugations)

Think of it like a personal assistant who:
- Remembers everything you've told them
- Learns your preferences and patterns
- Can recall relevant context when you ask about something
- Never forgets, but updates outdated information

## Why This Exists

Without memory, every conversation starts fresh. Agents forget:
- Your name and preferences
- Previous decisions and context
- Projects you're working on
- People and companies you've mentioned

With Engram:
- Agents recall relevant context automatically
- Profile captures your preferences
- Facts, entities, and relationships are tracked
- Contradictions are detected and resolved

## How It Fits Into OpenClaw

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    Agent Turn                        │    │
│  │                                                      │    │
│  │   1. User sends prompt                               │    │
│  │              ↓                                       │    │
│  │   2. ENGRAM: Recall relevant memories (→ inject)     │    │
│  │              ↓                                       │    │
│  │   3. Agent processes (with memory context)           │    │
│  │              ↓                                       │    │
│  │   4. ENGRAM: Buffer turn for extraction              │    │
│  │              ↓                                       │    │
│  │   5. (Periodically) Run extraction → persist         │    │
│  │                                                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────────────────┐    │
│  │    Engram       │    │       Storage               │    │
│  │  Orchestrator   │◄──►│  facts/ entities/ profile   │    │
│  └────────┬────────┘    └─────────────────────────────┘    │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐    ┌─────────────────────────────┐    │
│  │    GPT-5.2      │    │         QMD                 │    │
│  │  (extraction)   │    │  (search: BM25 + vector)    │    │
│  └─────────────────┘    └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

The plugin:
1. **Injects memory** - On `before_agent_start`, searches for relevant memories and adds to system prompt
2. **Buffers turns** - On `agent_end`, captures the user/assistant exchange
3. **Extracts facts** - Uses GPT-5.2 to extract facts, entities, and profile updates
4. **Stores memories** - Persists to markdown files with YAML frontmatter
5. **Consolidates** - Periodically merges, updates, and cleans memories

## Key Concepts

### 1. Memory Types

| Type | What It Is | Storage Location |
|------|------------|------------------|
| **Fact** | A single piece of information | `facts/{date}/` |
| **Entity** | A person, place, company, or project | `entities/` |
| **Profile** | User preferences and patterns | `profile.md` |
| **Correction** | Explicit correction of a fact | `corrections/` |
| **Question** | Curiosity questions for follow-up | `questions/` |

### 2. Fact Categories

Facts are categorized by type:

| Category | Examples |
|----------|----------|
| `fact` | "OpenClaw runs on port 3000" |
| `decision` | "We decided to use PostgreSQL" |
| `preference` | "User prefers dark mode" |
| `commitment` | "I will review the PR by Friday" |
| `relationship` | "Alice works with Bob on Project X" |
| `principle` | "Always write tests before code" |
| `moment` | "Today we launched v2.0" |
| `skill` | "User knows Python and TypeScript" |

### 3. The Recall Flow

When an agent starts processing a prompt:

```
User Prompt: "What was that API rate limit issue?"
        │
        ▼
┌───────────────────┐
│   QMD Search      │ ← Hybrid search (BM25 + vector + reranking)
│   (prompt text)   │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│   Boost Results   │ ← Recency, access count, importance
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  Format Context   │ ← Profile + memories + questions
└────────┬──────────┘
         │
         ▼
Injected into system prompt:
"## Memory Context (Engram)

## User Profile
- Prefers concise responses
- Works at Company X

## Relevant Memories
[1] /facts/2026-02-01/fact-123.md (score: 0.85)
API rate limit is 1000 requests per minute..."
```

### 4. The Extraction Flow

After an agent completes a turn:

```
Agent Turn Complete
        │
        ▼
┌───────────────────┐
│  Buffer Turn      │ ← Add to smart buffer
└────────┬──────────┘
         │
    (Buffer full or forced flush?)
         │
         ▼
┌───────────────────┐
│   GPT-5.2         │ ← Extract facts, entities, profile
│   Extraction      │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  Persist to       │ ← Write markdown files
│  Storage          │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  QMD Update       │ ← Re-index for search
└─────────────────── ┘
```

### 5. Consolidation

Periodically (every N extractions), the plugin:

1. **Merges duplicates** - Combines redundant facts
2. **Invalidates stale** - Marks outdated info as superseded
3. **Updates entities** - Merges fragmented entity files
4. **Cleans expired** - Removes fulfilled commitments, TTL-expired facts
5. **Summarizes** - Compresses old memories into summaries
6. **Consolidates profile** - Keeps profile.md under 600 lines

## File Structure

```
~/.openclaw/extensions/openclaw-engram/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── openclaw.plugin.json
├── CLAUDE.md              # Privacy policy
├── AGENTS.md              # This file
└── src/
    ├── index.ts           # Plugin entry, hook registration
    ├── config.ts          # Config parsing with defaults
    ├── types.ts           # TypeScript interfaces
    ├── logger.ts          # Logging wrapper
    ├── orchestrator.ts    # Core memory coordination
    ├── storage.ts         # File I/O for memories
    ├── buffer.ts          # Smart turn buffering
    ├── extraction.ts      # GPT-5.2 extraction engine
    ├── qmd.ts             # QMD search client
    ├── importance.ts      # Importance scoring
    ├── chunking.ts        # Large content chunking
    ├── threading.ts       # Conversation threading
    ├── topics.ts          # Topic extraction
    ├── tools.ts           # Agent tools
    └── cli.ts             # CLI commands

~/.openclaw/workspace/memory/local/
├── profile.md             # User profile
├── facts/                 # Daily fact directories
│   ├── 2026-02-01/
│   │   ├── fact-123.md
│   │   └── decision-456.md
│   └── 2026-02-07/
│       └── ...
├── entities/              # Entity files
│   ├── person-joshua-warren.md
│   ├── company-creatuity.md
│   └── project-openclaw.md
├── corrections/           # Explicit corrections
├── questions/             # Curiosity questions
├── summaries/             # Compressed old memories
└── state/
    ├── buffer.json        # Current buffer state
    └── meta.json          # Extraction counters
```

### Memory File Format

Facts and entities use markdown with YAML frontmatter:

```markdown
---
id: fact-1770469224307-eelr
category: decision
confidence: 0.85
created: 2026-02-07T10:00:00Z
updated: 2026-02-07T10:00:00Z
tags:
  - architecture
  - database
entityRef: project-openclaw
importance:
  score: 0.7
  reason: architectural decision
status: active
---

We decided to use PostgreSQL for the main database because it handles JSON well and has excellent extension support.
```

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "openclaw-engram": {
      "openaiApiKey": "${OPENAI_API_KEY}",
      "memoryDir": "~/.openclaw/workspace/memory/local",
      "workspaceDir": "~/.openclaw/workspace",
      "qmdEnabled": true,
      "qmdCollection": "openclaw-engram",
      "consolidateEveryN": 10,
      "maxMemoryTokens": 2000,
      "debug": false
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `openaiApiKey` | string | env var | Optional OpenAI API key for direct-client paths; local/gateway fallback can run without it |
| `memoryDir` | string | see above | Where to store memories |
| `workspaceDir` | string | see above | Workspace root |
| `qmdEnabled` | boolean | `true` | Enable QMD search |
| `qmdCollection` | string | `"openclaw-engram"` | QMD collection name |
| `qmdMaxResults` | number | `10` | Max search results |
| `consolidateEveryN` | number | `10` | Consolidate every N extractions |
| `maxMemoryTokens` | number | `2000` | Max tokens in context injection |
| `identityEnabled` | boolean | `true` | Enable identity reflections |
| `injectQuestions` | boolean | `false` | Inject curiosity questions |
| `commitmentDecayDays` | number | `90` | Days before expired commitments are cleaned |
| `debug` | boolean | `false` | Enable verbose logging |

## Hooks Used

### gateway_start

Initialize the memory system on gateway startup.

```typescript
api.on("gateway_start", async () => {
  await orchestrator.initialize();
  // - Ensure directories exist
  // - Load entity aliases
  // - Probe QMD availability
  // - Load buffer state
});
```

### before_agent_start

Inject memory context into agent's system prompt.

```typescript
api.on("before_agent_start", async (event, ctx) => {
  const prompt = event.prompt;
  const context = await orchestrator.recall(prompt);

  if (context) {
    return {
      systemPrompt: `## Memory Context (Engram)\n\n${context}`
    };
  }
});
```

### agent_end

Buffer the completed turn for later extraction.

```typescript
api.on("agent_end", async (event, ctx) => {
  if (!event.success) return;

  const messages = event.messages;
  const lastTurn = extractLastTurn(messages);

  for (const msg of lastTurn) {
    const cleaned = cleanUserMessage(msg.content);
    await orchestrator.processTurn(msg.role, cleaned, ctx.sessionKey);
  }
});
```

## The Orchestrator

The `Orchestrator` class is the heart of Engram:

### Key Methods

| Method | Purpose |
|--------|---------|
| `initialize()` | Set up storage, load aliases, probe QMD |
| `recall(prompt)` | Search and format memory context |
| `processTurn(role, content, sessionKey)` | Buffer a turn, maybe trigger extraction |
| `runExtraction(turns)` | Call GPT-5.2, persist results |
| `runConsolidation()` | Merge, update, clean memories |

### Subsystems

| Subsystem | Responsibility |
|-----------|----------------|
| `SmartBuffer` | Decides when to flush and extract |
| `ExtractionEngine` | GPT-5.2 prompts for extraction/consolidation |
| `StorageManager` | Read/write markdown files |
| `QmdClient` | Search via QMD CLI |
| `ThreadingManager` | Group memories by conversation thread |

## Common Tasks

### Manually Triggering Extraction

```bash
openclaw engram flush
```

### Searching Memories

```bash
openclaw engram search "API rate limit"
```

### Viewing Profile

```bash
cat ~/.openclaw/workspace/memory/local/profile.md
```

### Re-indexing QMD

```bash
qmd update openclaw-engram
qmd embed openclaw-engram
```

### Viewing Statistics

```bash
openclaw engram stats
```

## Footguns (Common Mistakes)

### 1. No OpenAI API Key

**Symptom**: Extraction never runs, no new memories.

**Cause**: API key not configured or not in gateway's environment.

**Fix**: Add to launchd plist:
```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENAI_API_KEY</key>
  <string>sk-...</string>
</dict>
```

### 2. QMD Not Available

**Symptom**: "QMD: not available" in logs, fallback to recent memories only.

**Cause**: `qmd` command not in PATH or not installed.

**Fix**: Install QMD and ensure it's in the gateway's PATH.

### 3. Profile Too Large

**Symptom**: Slow recall, context truncation.

**Cause**: profile.md exceeded recommended size.

**Fix**: The plugin auto-consolidates at 600 lines. You can also manually edit profile.md.

### 4. Stale QMD Index

**Symptom**: New memories not found in search.

**Cause**: QMD index not updated after extraction.

**Fix**: Run `qmd update <collection>` and `qmd embed <collection>`.

### 5. Memory Context Not Appearing

**Symptom**: Agents don't seem to know previous context.

**Cause**:
- Prompt too short (< 5 chars)
- No matching memories found
- Context trimmed due to token limit

**Fix**: Check debug logs, increase `maxMemoryTokens`.

### 6. Optional Fields in Zod Schemas

**Symptom**: OpenAI API rejects schemas with "optional" fields.

**Cause**: OpenAI Responses API requires `.optional().nullable()`, not just `.optional()`.

**Fix**: Always use `.optional().nullable()` for optional fields in Zod schemas passed to `zodTextFormat`.

### 7. Message Cleaning Not Working

**Symptom**: System metadata pollutes memories.

**Cause**: User messages contain injected context that wasn't cleaned.

**Fix**: The `cleanUserMessage()` function removes common patterns. Add new patterns if needed.

### 8. Entity Name Fragmentation

**Symptom**: Multiple entity files for the same person/project (e.g., "Josh", "Joshua", "Joshua Warren").

**Cause**: LLM used different name variants.

**Fix**: Add aliases to `storage.ts:normalizeEntityName()` function. Consolidation merges automatically.

## Testing Changes

```bash
# Build the plugin
cd ~/.openclaw/extensions/openclaw-engram
npm run build

# Full gateway restart (gateway_start hook needs this)
launchctl kickstart -k gui/501/ai.openclaw.gateway

# Or for hot reload (but gateway_start won't fire)
kill -USR1 $(pgrep openclaw-gateway)

# Trigger a conversation to test

# Check logs
grep "\[engram\]" ~/.openclaw/logs/gateway.log

# View extraction results
ls -la ~/.openclaw/workspace/memory/local/facts/$(date +%Y-%m-%d)/
```

## Debug Mode

Enable in `openclaw.json`:
```json
{
  "plugins": {
    "openclaw-engram": {
      "debug": true
    }
  }
}
```

This logs:
- Recall search results
- Buffer decisions
- Extraction prompts and results
- Consolidation actions
- QMD operations

## Advanced Features

### Access Tracking

Memories track how often they're accessed:
- `accessCount` increments on each recall
- `lastAccessed` timestamp updated
- Used for boosting frequently-accessed memories

### Importance Scoring

Each memory gets an importance score (0-1):
- Based on category, tags, and content patterns
- Higher importance = higher search ranking
- Protected from summarization

### Contradiction Detection

When a new fact conflicts with an existing one:
1. QMD finds similar memories
2. GPT-5.2 verifies contradiction
3. Old memory marked as superseded
4. Link created between old and new

### Memory Linking

Related memories are linked:
- `supports` - Provides evidence for
- `contradicts` - Conflicts with
- `elaborates` - Adds detail to
- `causes` / `caused_by` - Causal relationship

### Summarization

Old, low-importance memories are summarized:
- Triggered when memory count exceeds threshold
- Creates summary files with key facts
- Archives original memories
- Preserves important and entity-linked memories
