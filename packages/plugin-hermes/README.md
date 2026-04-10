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

engram:
  host: "127.0.0.1"
  port: 4318
  token: ""  # auto-loaded from ~/.engram/tokens.json
```

The Hermes-side config block is still named `engram:` today for compatibility.
Install and connector management are Remnic-branded; the plugin config surface
will stay legacy until the Hermes compatibility window closes.

## How It Works

- **`pre_llm_call`** — Recalls relevant memories before each LLM call and injects them into the system prompt
- **`sync_turn`** — Observes each conversation turn for future recall
- **`extract_memories`** — Performs deep extraction at session end
- **Explicit tools** — `engram_recall`, `engram_store`, `engram_search` registered as Hermes tools
