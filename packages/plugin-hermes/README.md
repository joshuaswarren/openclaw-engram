# remnic-hermes

Remnic MemoryProvider plugin for [Hermes Agent](https://github.com/hermes-agent/hermes).

Provides automatic memory recall on every LLM turn and observation of every response via the Hermes MemoryProvider protocol.

## Installation

```bash
pip install remnic-hermes
```

Or via the Remnic CLI:

```bash
remnic connectors install hermes
```

## Configuration

Add to your Hermes `config.yaml`:

```yaml
plugins:
  - remnic_hermes

remnic:
  host: "127.0.0.1"
  port: 4318
  token: ""  # auto-loaded from ~/.remnic/tokens.json
```

A legacy `engram:` block is still accepted during the Engram → Remnic compat
window. The plugin reads `remnic:` first and falls back to `engram:` if the
new key is absent, so existing configs keep working without edits.

## How It Works

- **`pre_llm_call`** — Recalls relevant memories before each LLM call and injects them into the system prompt as a `<remnic-memory>` block
- **`sync_turn`** — Observes each conversation turn for future recall
- **`extract_memories`** — Performs deep extraction at session end
- **Explicit tools** — `remnic_recall`, `remnic_store`, `remnic_search` registered as Hermes tools (legacy `engram_*` aliases remain available during the compat window)

## Python API

```python
from remnic_hermes import RemnicMemoryProvider, RemnicClient, RemnicHermesConfig
```

The legacy names `EngramMemoryProvider`, `EngramClient`, and `EngramHermesConfig` are kept as aliases for backward compatibility and will be removed in a future major release.

## License

MIT
