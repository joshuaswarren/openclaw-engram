# @remnic/cli

CLI for Remnic memory -- init, query, daemon management, connectors, curation, and more.

Part of [Remnic](https://github.com/joshuaswarren/remnic), the universal memory layer for AI agents.

## Install

```bash
npm install -g @remnic/cli
```

This installs the `remnic` command (and a legacy `engram` forwarder).

## Quick start

```bash
remnic init                     # Create remnic.config.json
export OPENAI_API_KEY=sk-...
export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)
remnic daemon start             # Start background server
remnic status                   # Verify it's running
remnic query "hello" --explain  # Test query with tier breakdown
```

## Commands

| Command | Description |
|---------|-------------|
| `remnic init` | Create a config file |
| `remnic daemon start/stop/status` | Manage the background server |
| `remnic query <text>` | Search memories |
| `remnic doctor` | Diagnose configuration issues |
| `remnic connectors install <name>` | Connect Claude Code, Codex CLI, Replit, etc. |
| `remnic curate` | Interactive memory curation |
| `remnic dedup` | Find and merge duplicate memories |
| `remnic sync` | Diff-aware sync with external sources |
| `remnic spaces` | Manage memory namespaces |
| `remnic bench list` | List published benchmark packs |
| `remnic bench run` | Run one or more published benchmark packs |
| `remnic bench compare` | Compare two stored benchmark results |
| `remnic bench baseline` | Save or list named benchmark baselines |
| `remnic bench export` | Export a stored benchmark result as JSON or CSV |
| `remnic bench providers discover` | Auto-detect local provider backends |

Run `remnic --help` for the full command list.

## Benchmarks

The phase-1 benchmark surface is exposed through `remnic bench`, with `remnic benchmark`
kept as a compatibility alias.

```bash
remnic bench list
remnic bench run --quick longmemeval
remnic bench run longmemeval --dataset-dir ~/datasets/longmemeval
remnic bench compare base-run candidate-run
remnic bench baseline save main candidate-run
remnic bench baseline list
remnic bench export candidate-run --format csv --output ./candidate.csv
remnic bench export candidate-run --format html --output ./report.html
remnic bench providers discover
remnic benchmark run --quick longmemeval
```

`--quick` uses the lightweight benchmark path with a single-item limit so you can
smoke-test the harness without running a full benchmark pass. When a benchmark
ships a bundled smoke fixture, `--quick` uses that tracked fixture by default;
full runs need a real benchmark dataset. In a repo checkout the CLI will use
`evals/datasets/<benchmark>` automatically; in packaged installs pass
`--dataset-dir <path>` explicitly.

## Connecting agents

Once the daemon is running, connect any supported agent:

```bash
remnic connectors install claude-code   # Claude Code (hooks + MCP)
remnic connectors install codex-cli     # Codex CLI (hooks + MCP)
remnic connectors install replit        # Replit (MCP only)
```

All agents share the same memory store.

## License

MIT
