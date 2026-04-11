# Hermes Agent Plugin

Remnic MemoryProvider for Hermes Agent. The deepest integration — memory is injected into every LLM call and conversation turns are observed automatically.

## Installation

### Option A: pip (recommended)

```bash
pip install remnic-hermes
remnic connectors install hermes
```

### Option B: Manual

```bash
# Copy to Hermes plugins directory
cp -r packages/plugin-hermes/remnic_hermes ~/.hermes/plugins/remnic/

# Or install as development plugin
cd packages/plugin-hermes
pip install -e .
```

The `remnic connectors install hermes` command:
1. Starts the Remnic daemon if not running
2. Generates a dedicated auth token
3. Writes Hermes `config.yaml` entry
4. Runs a health check

## What It Does

### MemoryProvider Protocol

The plugin implements Hermes v0.7.0+ MemoryProvider protocol:

| Method | When | What Happens |
|--------|------|-------------|
| `initialize(config)` | Plugin loads | Connects to Remnic, validates token |
| `pre_llm_call(messages)` | Before every LLM call | Recalls relevant memories, injects into system prompt |
| `sync_turn(transcript)` | After every response | Observes conversation turn, sends to Remnic for extraction |
| `extract_memories(session)` | Session ends | Triggers structured extraction of session learnings |
| `shutdown()` | Plugin unloads | Cleanup, flush pending observations |

### Explicit Tools

The plugin also registers tools the agent can call directly:

| Tool | Description |
|------|-------------|
| `remnic_recall` | Search memories with a query |
| `remnic_store` | Store a memory explicitly |
| `remnic_search` | Semantic search across all memories |

Legacy aliases `engram_recall`, `engram_store`, and `engram_search` are also
registered during the Engram → Remnic compat window so existing Hermes configs
that reference the older names keep working. New integrations should use the
`remnic_*` names.

## Why MemoryProvider > MCP

MCP gives Hermes tools to call, but the agent must choose to call them. The MemoryProvider injects context automatically — the agent doesn't need to know about Remnic at all. Memories appear in its context on every turn.

| Aspect | MCP Only | MemoryProvider |
|--------|----------|---------------|
| Recall | Agent must call `remnic_recall` | Automatic on every turn |
| Observe | Agent must call `remnic_store` | Automatic after every response |
| Latency | Tool call overhead | Pre-fetched, non-blocking |
| Reliability | Agent may forget to call | Structural — cannot be skipped |

## Configuration

### Hermes config.yaml

```yaml
memory_providers:
  - name: remnic
    module: remnic_hermes
    config:
      host: "127.0.0.1"
      port: 4318
      token_env: "REMNIC_AUTH_TOKEN"    # reads from env
      # Or inline:
      # token: "remnic_hm_..."
      namespace: "default"               # optional: scope to a profile
      recall_top_k: 12                   # memories per turn
      recall_mode: "auto"                # auto, minimal, full
```

### Environment Variables

```bash
export REMNIC_AUTH_TOKEN="remnic_hm_..."   # if using token_env
export REMNIC_HOST="127.0.0.1"             # optional override
export REMNIC_PORT="4318"                  # optional override
```

## Hermes Profile Isolation

Hermes profiles isolate agent state under `~/.hermes/profiles/<name>/`. Each profile can use a different Remnic namespace:

```yaml
# Profile: research
memory_providers:
  - name: remnic
    config:
      namespace: "research"

# Profile: coding
memory_providers:
  - name: remnic
    config:
      namespace: "coding"
```

Or use the default namespace to share memories across profiles.

## Troubleshooting

### "MemoryProvider remnic failed to initialize"

Remnic daemon isn't running:

```bash
remnic daemon status
remnic daemon install
```

### Memories not appearing in context

Check both sides of the integration:

```bash
remnic daemon status
hermes --version
```

### Import errors

Ensure the package is installed in the same Python environment as Hermes:

```bash
hermes --version
pip show remnic-hermes
```

## Uninstall

```bash
pip uninstall remnic-hermes
remnic connectors remove hermes
```
