# remnic-hermes

Remnic MemoryProvider plugin for [Hermes Agent](https://github.com/hermes-agent/hermes). Automatically injects memories into every LLM call and observes every conversation turn — no agent code changes required.

## Why MemoryProvider

MCP tools give an agent the ability to call memory functions, but only when the agent decides to. With the MemoryProvider protocol, recall happens structurally on every turn before the LLM is called, and observation happens after every response. The agent cannot forget to recall because the hook is not optional. A plain MCP integration requires the LLM to recognize that it should search for memories and then choose to call the tool; the MemoryProvider removes that dependency entirely.

| Aspect | MCP Only | MemoryProvider |
|--------|----------|---------------|
| Recall | Agent must call `remnic_recall` | Automatic on every turn |
| Observe | Agent must call `remnic_store` | Automatic after every response |
| Latency | Tool call overhead | Pre-fetched, non-blocking |
| Reliability | Agent may forget to call | Structural — cannot be skipped |

## Prerequisites

- **Remnic daemon** running and accessible on port `4318` (default). See the [Remnic repository](https://github.com/joshuaswarren/remnic) for installation instructions.
- **Hermes Agent v0.7.0 or later** — the MemoryProvider protocol was added in v0.7.0.
- **Python 3.10 or later**.

## Quick start

1. Install the plugin:
   ```bash
   pip install remnic-hermes
   ```

2. Wire Hermes to Remnic (starts the daemon if needed, generates an auth token, and writes the Hermes config entry):
   ```bash
   remnic connectors install hermes
   ```

3. Restart Hermes so it picks up the new config entry.

4. Verify the connection:
   ```bash
   hermes --version && pip show remnic-hermes
   ```
   Your agent should now have access to `remnic_recall`, `remnic_store`, and `remnic_search` tools. Call `remnic_recall` with any query to confirm memories are returned.

## Manual configuration

If you prefer not to use `remnic connectors install`, add the following to your Hermes `config.yaml` directly:

```yaml
plugins:
  - remnic_hermes

remnic:
  host: "127.0.0.1"      # Remnic daemon host. Default: 127.0.0.1
  port: 4318             # Remnic daemon port. Default: 4318
  token: ""              # Auth token. Leave empty to auto-load from ~/.remnic/tokens.json.
  session_key: ""        # Session identifier. Auto-generated as hermes-<12hex> if not set.
  timeout: 30.0          # HTTP request timeout in seconds. Default: 30.0
```

A legacy `engram:` config block is also accepted during the Engram to Remnic transition. The plugin reads `remnic:` first and falls back to `engram:` when the `remnic:` key is absent, so existing configs continue working without edits.

### Environment variable overrides

| Variable | Overrides | Description |
|----------|-----------|-------------|
| `REMNIC_HOST` | `remnic.host` | Daemon hostname or IP |
| `REMNIC_PORT` | `remnic.port` | Daemon port number |
| `ENGRAM_HOST` | `remnic.host` | Legacy fallback for `REMNIC_HOST` |
| `ENGRAM_PORT` | `remnic.port` | Legacy fallback for `REMNIC_PORT` |

Environment variables are only consulted when the corresponding field is absent from the config block. Inline config values take precedence over environment variables.

The auth token is not read from an environment variable. It is either set inline (`token: "..."`) or auto-loaded from the Remnic token store at `~/.remnic/tokens.json` (falling back to `~/.engram/tokens.json` during the compat window).

### Token bootstrap

`remnic connectors install hermes` is the recommended way to get a token into place. It:

1. Starts the Remnic daemon if it is not already running.
2. Generates a dedicated per-connector auth token scoped to Hermes.
3. Writes the token to `~/.remnic/tokens.json`.
4. Adds the `remnic:` block to your Hermes `config.yaml`.
5. Runs a health check against the daemon.

If you provision tokens manually, write a JSON file at `~/.remnic/tokens.json` in the format:

```json
{
  "tokens": [
    { "connector": "hermes", "token": "remnic_hm_...", "createdAt": "2026-01-01T00:00:00Z" }
  ]
}
```

The plugin searches for a `connector: "hermes"` entry first, then falls back to `connector: "openclaw"`.

## What it does

| Method | Trigger | Behavior |
|--------|---------|----------|
| `initialize` | Plugin loads | Opens an HTTP client to the Remnic daemon and pings `/health`. A failed health check is non-fatal — the daemon may start later. |
| `pre_llm_call` | Before every LLM call | Recalls up to 8 memories using the last user message as the query. Skipped if the user message is fewer than 3 words. Injects a `<remnic-memory>` block into the system prompt when results are found. |
| `sync_turn` | After every response | Sends the last 2 messages (user + assistant) to the Remnic daemon for real-time observation. |
| `extract_memories` | Session ends | Sends the full session transcript to the daemon for deep structured extraction. |
| `shutdown` | Plugin unloads | Closes the HTTP client. |

## Tools it registers

| Tool name | Description |
|-----------|-------------|
| `remnic_recall` | Recall memories matching a natural language query |
| `remnic_store` | Store a memory explicitly |
| `remnic_search` | Full-text search across all stored memories |

During the Engram to Remnic compat window, three legacy aliases are also registered: `engram_recall`, `engram_store`, `engram_search`. These route to the same handlers. Their schema descriptions intentionally say "Engram" (not "Remnic") so that tool names and descriptions agree when a language model surfaces the legacy names. The `engram_*` aliases will be removed in a future major release. New integrations should use the `remnic_*` names.

## Profiles and namespaces

Hermes isolates agent state per profile under `~/.hermes/profiles/<name>/`. Each profile loads its own `config.yaml`, so you can run separate `remnic:` blocks with different `session_key` values to keep memory contexts distinct. See [docs/plugins/hermes.md](../../docs/plugins/hermes.md) for a worked example.

## Verify it is working

```bash
hermes --version && pip show remnic-hermes
```

Then start a session and call `remnic_recall` with a short phrase. If the daemon is healthy you will get a JSON response; if memories exist for that query they will appear in the `context` field. You can also check `<remnic-memory>` blocks in the Hermes debug log to confirm automatic recall is firing on each turn.

## Troubleshooting

**Daemon not running**

```bash
remnic daemon status
remnic daemon install    # installs and starts the launchd/systemd service
```

**Token missing — calls return 401**

Check that `~/.remnic/tokens.json` exists and contains a `hermes` connector entry. Re-running `remnic connectors install hermes` regenerates the token and re-writes the file.

```bash
cat ~/.remnic/tokens.json
```

**Import error — `ModuleNotFoundError: No module named 'remnic_hermes'`**

The package must be installed in the same Python environment Hermes uses:

```bash
which python && pip show remnic-hermes
hermes --version
```

If they differ, install into the correct environment: `<path-to-hermes-python> -m pip install remnic-hermes`.

**Memories not appearing in context**

Memories are only injected when the last user message is 3 or more words and the daemon is reachable. Check daemon health first, then verify the query length. You can force a manual recall via the tool to confirm the round-trip works:

```bash
remnic daemon status
```

## Uninstall

```bash
pip uninstall remnic-hermes
remnic connectors remove hermes
```

`remnic connectors remove hermes` revokes the token and removes the config entry from Hermes `config.yaml`.

## Further reading

- [Full reference: docs/plugins/hermes.md](../../docs/plugins/hermes.md) — complete config schema, recall/observe/extract internals, profile isolation examples, and migration notes from the Engram era.
- [Remnic repository](https://github.com/joshuaswarren/remnic) — daemon installation and overall architecture.
- [Hermes Agent](https://github.com/hermes-agent/hermes) — the agent framework this plugin extends.

## License

MIT
