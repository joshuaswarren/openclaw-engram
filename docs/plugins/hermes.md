# Hermes Agent Plugin

Remnic MemoryProvider for [Hermes Agent](https://github.com/hermes-agent/hermes). Provides automatic memory recall on every LLM turn and automatic observation of every response via the Hermes MemoryProvider protocol. The deepest available integration — memory is structural, not optional.

## Contents

- [Why MemoryProvider](#why-memoryprovider)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration reference](#configuration-reference)
- [Environment variable overrides](#environment-variable-overrides)
- [Token bootstrap](#token-bootstrap)
- [How the provider works](#how-the-provider-works)
- [Tools registered](#tools-registered)
- [Profile and session isolation](#profile-and-session-isolation)
- [Error handling philosophy](#error-handling-philosophy)
- [Engram compat window](#engram-compat-window)
- [Troubleshooting](#troubleshooting)
- [Migration notes (Engram era)](#migration-notes-engram-era)
- [Uninstall](#uninstall)

---

## Why MemoryProvider

MCP gives Hermes tools it can call, but the agent must decide to call them. The MemoryProvider protocol hooks into Hermes at the framework level so memory operations happen regardless of what the agent chooses to do.

| Aspect | MCP Only | MemoryProvider |
|--------|----------|---------------|
| Recall | Agent must call `remnic_recall` | Automatic on every turn |
| Observe | Agent must call `remnic_store` | Automatic after every response |
| Latency | Tool call overhead per turn | Pre-fetched, non-blocking |
| Reliability | Agent may omit the call | Structural — cannot be skipped |

The plugin also registers the `remnic_*` tools for cases where the agent should control recall or storage explicitly — for example, pinning a specific fact mid-session. The two approaches are complementary.

---

## Prerequisites

- **Remnic daemon** running on `127.0.0.1:4318` (configurable). See the [Remnic repository](https://github.com/joshuaswarren/remnic) for installation.
- **Hermes Agent v0.7.0 or later** — the MemoryProvider protocol was introduced in v0.7.0.
- **Python 3.10 or later**.

---

## Installation

### Option A: pip + CLI (recommended)

```bash
pip install remnic-hermes
remnic connectors install hermes
```

`remnic connectors install hermes` starts the daemon if needed, generates an auth token, writes `~/.remnic/tokens.json`, and adds the `remnic:` block to your Hermes `config.yaml`. Restart Hermes after running it.

### Option B: pip only (manual config)

```bash
pip install remnic-hermes
```

Then add the config block manually — see [Configuration reference](#configuration-reference).

### Option C: editable install from source

```bash
cd packages/plugin-hermes
pip install -e ".[dev]"
```

---

## Configuration reference

The plugin entry point is `register(ctx)` in `remnic_hermes/__init__.py`. It reads configuration from `ctx.config["remnic"]`, falling back to `ctx.config["engram"]` if the `remnic` key is absent. The extracted dict is passed directly to `RemnicMemoryProvider`.

In Hermes `config.yaml`, the config block sits at the **top level** under a `remnic:` key (or `engram:` for legacy configs), alongside the `plugins:` list:

```yaml
plugins:
  - remnic_hermes

remnic:
  host: "127.0.0.1"
  port: 4318
  token: ""
  session_key: ""
  timeout: 30.0
```

### Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | `"127.0.0.1"` | Hostname or IP of the Remnic daemon. Overridden by `REMNIC_HOST` env var. |
| `port` | integer | `4318` | TCP port of the Remnic daemon. Overridden by `REMNIC_PORT` env var. |
| `token` | string | `""` | Auth token for the daemon. If empty, auto-loaded from the token store (see [Token bootstrap](#token-bootstrap)). |
| `session_key` | string | `""` | Session identifier passed on every recall/observe call. If empty, auto-generated as `hermes-<12 random hex chars>` at startup. |
| `timeout` | float | `30.0` | HTTP request timeout in seconds applied to all daemon calls. |

No other fields are read. Fields documented elsewhere (such as `namespace`, `recall_top_k`, `recall_mode`, or `token_env`) do not exist in this implementation.

---

## Environment variable overrides

Environment variables are consulted only when the corresponding field is absent from the config block. Inline config values win.

| Variable | Overrides | Notes |
|----------|-----------|-------|
| `REMNIC_HOST` | `remnic.host` | Primary |
| `REMNIC_PORT` | `remnic.port` | Primary |
| `ENGRAM_HOST` | `remnic.host` | Legacy fallback; checked when `REMNIC_HOST` is unset |
| `ENGRAM_PORT` | `remnic.port` | Legacy fallback; checked when `REMNIC_PORT` is unset |

**Precedence (highest to lowest):** inline config field → `REMNIC_*` env var → `ENGRAM_*` env var → compiled default.

The auth token is **not** read from an environment variable. It comes from the inline `token:` field or the token store file.

---

## Token bootstrap

### Automatic (via CLI)

`remnic connectors install hermes` handles the full flow:

1. Starts the Remnic daemon if it is not running.
2. Generates a per-connector auth token scoped to Hermes.
3. Writes the token to `~/.remnic/tokens.json`.
4. Adds the `remnic:` block to Hermes `config.yaml`.
5. Runs a daemon health check.

### Manual

Write `~/.remnic/tokens.json` in the following format:

```json
{
  "tokens": [
    { "connector": "hermes", "token": "remnic_hm_...", "createdAt": "2026-01-01T00:00:00Z" }
  ]
}
```

The token loader searches for `connector: "hermes"` first, then `connector: "openclaw"`. It also checks `~/.engram/tokens.json` as a legacy fallback.

### Token resolution order

1. Inline `token:` field in `config.yaml`.
2. `connector: "hermes"` entry in `~/.remnic/tokens.json`.
3. `connector: "openclaw"` entry in `~/.remnic/tokens.json`.
4. `connector: "hermes"` entry in `~/.engram/tokens.json` (legacy fallback).
5. `connector: "openclaw"` entry in `~/.engram/tokens.json` (legacy fallback).
6. Empty string — daemon calls will return 401 until a token is configured.

---

## How the provider works

### `initialize`

Called when the plugin loads. Creates an `httpx.AsyncClient` pointed at `http://<host>:<port>/engram/v1` and issues a `GET /health` request. A failed health check is swallowed and treated as non-fatal — the daemon may become available later in the session. If the client is not initialized (daemon was never reachable), all subsequent hook methods return early without errors.

Note: the HTTP base path currently uses `/engram/v1` because the Remnic daemon exposes a legacy surface during the v1.x compat window. This will change to `/remnic/v1` once the daemon ships the dual-path rollout.

### `pre_llm_call`

Called before every LLM request. Behavior:

1. Scans `messages` in reverse to find the last message with `role: "user"`.
2. **Skips recall entirely** if the user message is absent or fewer than 3 words (whitespace-split). This avoids triggering recall on very short acknowledgments like "ok" or "thanks".
3. Issues `POST /recall` with the user message as the query, `sessionKey`, `topK: 8`, and `mode: "minimal"`.
4. If the response has a non-empty `context` field and `count > 0`, returns a `<remnic-memory count="N">` block that Hermes injects into the system prompt.
5. Exceptions are swallowed; returns `""` on any error so the LLM call proceeds normally.

### `sync_turn`

Called after every agent response. Takes the full session `transcript` and sends the **last 2 messages** (user + assistant) to `POST /observe`. This provides near-real-time observation without the cost of replaying the entire transcript on every turn.

Exceptions are swallowed.

### `extract_memories`

Called when the session ends. Receives a `session` dict; reads `session["messages"]` and sends the **full transcript** to `POST /observe`. This is the deep extraction pass — the daemon analyses the complete conversation for structured memory candidates.

Exceptions are swallowed.

### `shutdown`

Closes the `httpx.AsyncClient`. Safe to call when the client was never initialized.

---

## Tools registered

| Tool name | Parameters | Description |
|-----------|-----------|-------------|
| `remnic_recall` | `query: string` | Recall memories from Remnic matching a natural language query |
| `remnic_store` | `content: string` | Store a memory in Remnic for future recall |
| `remnic_search` | `query: string` | Full-text search across all Remnic memories |

Each tool handler returns the raw JSON response from the daemon or `{"error": "Not connected to Remnic"}` when the client is not initialized.

The `remnic_*` tools give the agent explicit control for cases where automatic recall is insufficient — for example, storing a specific fact the agent has derived mid-session.

---

## Profile and session isolation

Hermes profiles live under `~/.hermes/profiles/<name>/` and each loads its own `config.yaml`. You can use different `session_key` values to keep memory contexts distinct across profiles:

```yaml
# ~/.hermes/profiles/research/config.yaml
plugins:
  - remnic_hermes

remnic:
  host: "127.0.0.1"
  port: 4318
  session_key: "research"
```

```yaml
# ~/.hermes/profiles/coding/config.yaml
plugins:
  - remnic_hermes

remnic:
  host: "127.0.0.1"
  port: 4318
  session_key: "coding"
```

The `session_key` is passed on every `/recall` and `/observe` call, so the daemon can scope retrieval to sessions with matching keys. If `session_key` is omitted, the provider generates a random key (`hermes-<12hex>`) at startup; this means recall will only find memories from the same process lifetime unless you set a stable key.

To share memories across all profiles, omit `session_key` in both configs and rely on the Remnic daemon's global index.

---

## Error handling philosophy

Every MemoryProvider hook (`initialize`, `pre_llm_call`, `sync_turn`, `extract_memories`) wraps its daemon call in a bare `except Exception: pass` block. This is intentional: Remnic being unavailable must never break the agent. The agent continues normally; it just loses memory context for that turn or session.

This design means:
- The daemon can be restarted mid-session without crashing Hermes.
- Misconfigured tokens produce silent auth failures rather than agent crashes.
- Network blips are non-fatal.

If you need to diagnose silent failures, check daemon health directly:

```bash
remnic daemon status
curl -s http://127.0.0.1:4318/engram/v1/health
```

---

## Engram compat window

During the Engram to Remnic rebrand, the plugin registers six tools instead of three:

| Tool name | Status | Notes |
|-----------|--------|-------|
| `remnic_recall` | Current | Use for new integrations |
| `remnic_store` | Current | Use for new integrations |
| `remnic_search` | Current | Use for new integrations |
| `engram_recall` | Legacy alias | Routes to the same handler as `remnic_recall` |
| `engram_store` | Legacy alias | Routes to the same handler as `remnic_store` |
| `engram_search` | Legacy alias | Routes to the same handler as `remnic_search` |

The legacy tool schemas deliberately describe themselves as "Engram" tools (e.g., "Recall memories from Engram..."). This is intentional: when a language model surfaces the `engram_*` names, the description must agree with the name so the model does not confuse the two tool sets. Do not update these descriptions to say "Remnic".

The Python class aliases `EngramMemoryProvider`, `EngramClient`, and `EngramHermesConfig` are preserved for import-path compatibility and will be removed in a future major release.

The `engram:` config block is also still accepted as a fallback. If your `config.yaml` has `engram:` instead of `remnic:`, everything works without changes.

---

## Troubleshooting

### "MemoryProvider remnic failed to initialize" or 401 errors

The auth token is missing or invalid. Re-run the connector install to regenerate it:

```bash
remnic connectors install hermes
cat ~/.remnic/tokens.json    # verify a hermes entry exists
```

### Daemon not running

```bash
remnic daemon status
remnic daemon install        # installs and starts the launchd/systemd service
```

Verify the HTTP surface is responding:

```bash
curl -s http://127.0.0.1:4318/engram/v1/health
```

### `ModuleNotFoundError: No module named 'remnic_hermes'`

The package is not installed in the Python environment Hermes uses:

```bash
which python && pip show remnic-hermes
hermes --version
```

Install into the correct environment: `<path-to-hermes-python> -m pip install remnic-hermes`.

### Memories not appearing in context

1. Confirm the daemon is healthy: `remnic daemon status`.
2. Confirm the query is at least 3 words — `pre_llm_call` skips recall for shorter messages.
3. Confirm the token is valid: a 401 is swallowed silently, so daemon health does not catch it.
4. Use the explicit tool to test the round-trip: call `remnic_recall` with a query. If it returns `{"error": "Not connected to Remnic"}`, `initialize` never completed successfully.

### Memories from a previous session are not recalled

If `session_key` is not set, a new random key is generated each startup. Set a stable `session_key` in the config if you want cross-session recall to scope correctly:

```yaml
remnic:
  session_key: "my-agent"
```

Or leave it blank to rely on the Remnic daemon's global search (the daemon indexes all sessions, but `sessionKey` may affect ranking).

---

## Migration notes (Engram era)

If you are upgrading from a configuration that used the `engram-hermes` package or an `engram:` config block:

1. `pip install remnic-hermes` replaces `engram-hermes`. Uninstall the old package first: `pip uninstall engram-hermes`.
2. Your `config.yaml` `engram:` block continues to work without changes. You can rename it to `remnic:` at any time — both are accepted.
3. Tool calls to `engram_recall`, `engram_store`, and `engram_search` continue to work. No Hermes system prompt or tool-list changes are required.
4. Python imports of `EngramMemoryProvider`, `EngramClient`, and `EngramHermesConfig` continue to resolve.
5. When you are ready to fully migrate: rename `engram:` to `remnic:` in `config.yaml` and update any explicit tool references to `remnic_*`.

---

## Uninstall

```bash
pip uninstall remnic-hermes
remnic connectors remove hermes
```

`remnic connectors remove hermes` revokes the token and removes the `remnic:` block from Hermes `config.yaml`.
