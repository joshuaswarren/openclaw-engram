# FAISS Sidecar

This directory documents the Python sidecar used by the TypeScript FAISS adapter.

## Files

- `../faiss_index.py`: JSON-in/JSON-out CLI (`upsert`, `search`, `health`)
- `../faiss_requirements.txt`: Python dependencies

## Install

```bash
python3 -m venv .venv-faiss
source .venv-faiss/bin/activate
pip install -r scripts/faiss_requirements.txt
```

## Runtime Modes

- Default mode uses deterministic `__hash__` embeddings to avoid heavy model initialization on per-command subprocess calls.
- To enable sentence-transformers models, set `ENGRAM_FAISS_ENABLE_ST=1` in the sidecar environment.

## Contract

The sidecar reads one JSON payload from stdin and writes exactly one JSON object to stdout.

### Commands

1. `upsert`
- Input: `{ "modelId", "indexPath", "chunks": [...] }`
- Output: `{ "ok": true, "upserted": <number> }`

2. `search`
- Input: `{ "modelId", "indexPath", "query", "topK" }`
- Output: `{ "ok": true, "results": [{ "path", "snippet", "score" }] }`

3. `health`
- Input: `{ "modelId", "indexPath" }`
- Output: `{ "ok": true, "status": "ok|degraded|error", "error"?: "..." }`

## Storage Layout

`indexPath` should point to a plugin-managed directory under:

`<memoryDir>/state/conversation-index/faiss/`

Artifacts written by the sidecar:

- `index.faiss`: FAISS index file
- `metadata.jsonl`: chunk metadata in insertion order

## Fail-open Notes

- On validation/dependency errors, sidecar emits `{ "ok": false, "error": "..." }`.
- Adapter treats this as fail-open and conversation recall degrades without crashing hook execution.
