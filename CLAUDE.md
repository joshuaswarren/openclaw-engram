# openclaw-engram

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
7. **QMD `query` is intentional** — DO NOT change from `query` to `search` or `vsearch`. The `query` command provides LLM expansion + reranking that engram relies on. Engram's own reranking was disabled because `qmd query` handles it.
8. **QMD local patches** — PRs #166, #112, #117 are applied locally to `~/.bun/install/global/node_modules/qmd/`. These will be overwritten by `bun install -g github:tobi/qmd` — reapply if needed until merged upstream.
