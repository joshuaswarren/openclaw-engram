# API Reference

## Agent Tools

These tools are registered with the OpenClaw gateway and are callable by agents.

### `memory_search`

Search memories by semantic similarity.

**Parameters:**
- `query` (string, required) — The search query.
- `limit` (number, optional, default: 10) — Max results to return.
- `category` (string, optional) — Filter by memory category.
- `namespace` (string, optional) — Filter by namespace.

**Returns:** Array of matching memories with scores, paths, and content snippets.

---

### `memory_store`

Manually store a memory without going through the extraction pipeline.

**Parameters:**
- `content` (string, required) — The memory content.
- `category` (string, required) — One of: `fact`, `preference`, `correction`, `entity`, `decision`, `relationship`, `principle`, `commitment`, `moment`, `skill`.
- `confidence` (number, optional, default: 0.9) — Confidence score 0–1.
- `tags` (string[], optional) — Tags to attach.

**Returns:** The stored memory's ID and file path.

---

### `memory_profile`

Retrieve the current behavioral profile.

**Parameters:** None.

**Returns:** The contents of `profile.md`.

---

### `memory_entities`

List all tracked entities.

**Parameters:**
- `type` (string, optional) — Filter by entity type (person, company, project, place).

**Returns:** Array of entity summaries with names, types, and fact counts.

---

### `memory_promote`

Promote a memory to a shared namespace so other agents can access it.

**Parameters:**
- `memoryId` (string, required) — The ID of the memory to promote.
- `targetNamespace` (string, optional, default: `shared`) — Destination namespace.

**Returns:** The new path in the shared namespace.

---

### `memory_feedback`

Record explicit feedback on a recalled memory.

**Parameters:**
- `memoryId` (string, required) — The ID of the memory.
- `signal` (string, required) — One of: `thumbs_up`, `thumbs_down`.
- `note` (string, optional) — Optional explanation.

**Returns:** Confirmation with updated memory status.

---

### `identity_anchor_get`

Read the identity continuity anchor document used for recovery-safe identity context.

**Parameters:** None.

**Returns:** Current identity anchor markdown, or guidance if missing/disabled.

---

### `identity_anchor_update`

Conservatively merge updates into identity anchor sections (non-destructive by default).

**Parameters:**
- `identityTraits` (string, optional) — Updates for `Identity Traits`.
- `communicationPreferences` (string, optional) — Updates for `Communication Preferences`.
- `operatingPrinciples` (string, optional) — Updates for `Operating Principles`.
- `continuityNotes` (string, optional) — Updates for `Continuity Notes`.

**Returns:** Updated anchor content with merged sections.

---

### `continuity_incident_open`

Open a continuity incident with symptom and optional context fields.

**Parameters:**
- `symptom` (string, required)
- `triggerWindow` (string, optional)
- `suspectedCause` (string, optional)

**Returns:** Created incident record summary.

---

### `continuity_incident_close`

Close an existing continuity incident with required fix and verification fields.

**Parameters:**
- `id` (string, required)
- `fixApplied` (string, required)
- `verificationResult` (string, required)
- `preventiveRule` (string, optional)

**Returns:** Closed incident record summary, or not-found message.

---

### `continuity_incident_list`

List continuity incidents with optional state filtering.

**Parameters:**
- `state` (`open` | `closed` | `all`, optional, default `open`)
- `limit` (number, optional, default `25`, max `200`)

**Returns:** Formatted incident list.

---

## CLI Commands

Run via `openclaw engram <command>`:

| Command | Description |
|---------|-------------|
| `flush` | Force-flush the buffer and run extraction now |
| `search <query>` | Search memories from the terminal |
| `stats` | Show memory counts, buffer state, and QMD status |
| `export [--format json\|sqlite\|md]` | Export all memories to a portable file |
| `import <file>` | Import memories from a portable file |
| `purge` | Delete all memories (requires confirmation) |
| `continuity incidents [--state open\|closed\|all] [--limit N]` | List continuity incidents |
| `continuity incident-open --symptom <text> [--trigger-window <text>] [--suspected-cause <text>]` | Open a continuity incident |
| `continuity incident-close --id <id> --fix-applied <text> --verification-result <text> [--preventive-rule <text>]` | Close a continuity incident |

## Plugin Hooks

| Hook | When it fires | What Engram does |
|------|--------------|-----------------|
| `gateway_start` | Gateway process starts | Initialize storage, probe QMD, load buffer |
| `before_agent_start` | Before each agent session | Recall relevant memories, inject into system prompt |
| `agent_end` | After each agent turn | Buffer the turn, maybe trigger extraction |
