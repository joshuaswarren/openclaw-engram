# API Reference

## Universal Access Layer

Engram exposes one shared local service layer through both HTTP and MCP adapters. The HTTP server is bearer-token protected by default and binds to loopback unless you override `agentAccessHttp.host`.

### HTTP

Core routes:

- `GET /engram/v1/health` — service health plus projection/search availability
- `POST /engram/v1/recall` — shared recall entrypoint
- `POST /engram/v1/recall/explain` — last recall snapshot plus intent/graph debug state
- `POST /engram/v1/memories` — explicit memory write path
- `POST /engram/v1/suggestions` — queue review-first memory suggestions
- `GET /engram/v1/memories` — browse memories with query/status/category filters
- `GET /engram/v1/memories/:id` — fetch one memory
- `GET /engram/v1/memories/:id/timeline` — fetch one memory lifecycle timeline
- `GET /engram/v1/entities` — list entities
- `GET /engram/v1/entities/:name` — fetch one entity
- `GET /engram/v1/review-queue` — latest governance review bundle when present
- `GET /engram/v1/maintenance` — health plus latest governance artifact summary
- `POST /engram/v1/review-disposition` — operator review decision write path

Recall request fields:

- `query` (required)
- `sessionKey`
- `namespace`
- `topK`
- `mode` (`auto`, `no_recall`, `minimal`, `full`, `graph_mode`)
- `includeDebug`

Recall response fields:

- `results`
- `count`
- `traceId`
- `plannerMode`
- `fallbackUsed`
- `sourcesUsed`
- `budgetsApplied`
- `latencyMs`

Write request envelope:

- `schemaVersion`
- `idempotencyKey`
- `dryRun`

Write endpoints share the same explicit-capture validation and duplicate suppression as the OpenClaw tooling, enforce request-size limits, and are rate-limited before mutation paths run.

### MCP

Run the server with:

```bash
openclaw engram access mcp-serve
```

Available MCP tools:

- `engram.recall`
- `engram.recall_explain`
- `engram.memory_get`
- `engram.memory_timeline`
- `engram.memory_store`
- `engram.suggestion_submit`
- `engram.entity_get`
- `engram.review_queue_list`

The MCP adapter calls the same `EngramAccessService` methods used by HTTP, so equivalent request classes return the same structured payloads.

### MCP over HTTP

The HTTP server also exposes an MCP JSON-RPC endpoint at `POST /mcp`, allowing remote MCP clients (e.g., Codex CLI, Claude Code) to use Engram tools over HTTP instead of STDIO:

```bash
openclaw engram access http-serve --host 0.0.0.0 --port 4318 --token "$TOKEN"
```

Clients send standard MCP JSON-RPC requests to `http://<host>:4318/mcp` with an `Authorization: Bearer <token>` header. All 8 MCP tools are available. Write operations (`engram.memory_store`, `engram.suggestion_submit`) are rate-limited consistently with the REST write endpoints — dry runs and idempotency replays do not count toward the limit.

**Namespace-enabled deployments:** If you have `namespacesEnabled: true`, pass `--principal <name>` to set the authenticated principal for all MCP connections. The principal must appear in `writePrincipals` for the target namespace. Without `--principal`, the principal resolves to `"default"`, which may not have write access:

```bash
openclaw engram access http-serve --host 0.0.0.0 --principal generalist --token "$TOKEN"
```

Deployments with `namespacesEnabled: false` (the default) do not need `--principal` — all writes are permitted.

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

`memory_store` shares the same explicit-capture validation, sanitization, duplicate handling, lifecycle logging, and review-queue fallback used by `memory_capture`.

**Returns:** The stored memory's ID and file path, or the duplicate/review item identifier when Engram suppresses a direct write.

---

### `memory_capture`

Create a structured explicit memory note that obeys `captureMode` policy.

Prefer this tool over inline notes when tool use is available. In `explicit` mode it is the primary write path; in `hybrid` mode it bypasses buffering and persists immediately when validation passes.

**Parameters:**
- `content` (string, required) — One durable fact, decision, correction, commitment, or other standalone note.
- `category` (string, optional, default: `fact`) — One of: `fact`, `preference`, `correction`, `entity`, `decision`, `relationship`, `principle`, `commitment`, `moment`, `skill`, `rule`.
- `confidence` (number, optional, default: `0.95`) — Confidence score 0–1.
- `namespace` (string, optional) — Requested namespace, subject to namespace policy.
- `tags` (string[], optional) — Tags to attach.
- `entityRef` (string, optional) — Related entity id.
- `ttl` (string, optional) — ISO timestamp or relative duration like `30m`, `12h`, `7d`, or `2w`.
- `sourceReason` (string, optional) — Human/operator rationale recorded in lifecycle metadata.

Validation rules:
- content must be 10–4000 chars
- nested `<memory_note>` blocks are rejected
- unsafe categories, secrets, credentials, and invalid namespace targets are rejected
- exact duplicates are suppressed before write

If a direct write is rejected, Engram queues a sanitized `pending_review` memory instead of silently dropping the request.

**Returns:** The accepted memory id, duplicate target id, or queued review item id.

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

### `memory_action_apply`

Record a memory-action telemetry event with optional safe dry-run mode.

**Parameters:**
- `action` (string, required) — One of: `store_episode`, `store_note`, `update_note`, `create_artifact`, `summarize_node`, `discard`, `link_graph`.
- `outcome` (string, optional, default: `applied`) — One of: `applied`, `skipped`, `failed`.
- `reason` (string, optional) — Operator rationale or note.
- `memoryId` (string, optional) — Targeted memory ID if applicable.
- `namespace` (string, optional) — Namespace to write telemetry into.
- `sourcePrompt` (string, optional) — Prompt text used only for hash telemetry.
- `dryRun` (boolean, optional, default: `false`) — Validate/report action without persisting telemetry.

**Returns:** Confirmation text; in dry-run, reports what would be recorded.

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

### `continuity_loop_add_or_update`

Add or update a continuity improvement loop entry in `identity/improvement-loops.md`.

**Parameters:**
- `id` (string, required) — Stable loop identifier.
- `cadence` (`daily` | `weekly` | `monthly` | `quarterly`, required)
- `purpose` (string, required)
- `status` (`active` | `paused` | `retired`, required)
- `killCondition` (string, required)
- `lastReviewed` (string, optional, ISO timestamp)
- `notes` (string, optional)

**Returns:** Saved loop summary.

---

### `continuity_loop_review`

Update review metadata on an existing continuity loop entry.

**Parameters:**
- `id` (string, required)
- `status` (`active` | `paused` | `retired`, optional)
- `notes` (string, optional)
- `reviewedAt` (string, optional, ISO timestamp)

**Returns:** Updated loop summary, or not-found message.

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
| `action-audit [--namespace <name>] [--limit N]` | Show namespace-aware memory action outcomes and policy decisions |

## Plugin Hooks

| Hook | When it fires | What Engram does |
|------|--------------|-----------------|
| `gateway_start` | Gateway process starts | Initialize storage, probe QMD, load buffer |
| `before_agent_start` | Before each agent session | Recall relevant memories, inject into system prompt |
| `agent_end` | After each agent turn | Buffer the turn, maybe trigger extraction |
