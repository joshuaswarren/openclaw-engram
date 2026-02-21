# openclaw-engram - Agent Guide

## What This Plugin Does (Simple Explanation)

This plugin gives OpenClaw agents long-term memory that persists across conversations.

## PR Hardening Rule (All Agents)

If you touch retrieval/planner/cache/config logic, you must run the hardening gate in:
`docs/ops/pr-review-hardening-playbook.md`

This is mandatory before claiming a PR is review-clean.

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
| `openaiApiKey` | string | env var | OpenAI API key for GPT-5.2 |
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
