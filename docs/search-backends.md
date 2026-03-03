# Search Backends

Engram v9 supports six search backends through a pluggable port/adapter architecture. Each backend implements the same `SearchBackend` interface, so switching engines requires only a config change — no code modifications.

## Choosing a Backend

| Backend | Dependencies | Setup | Search Quality | Best For |
|---------|-------------|-------|---------------|----------|
| **QMD** | QMD binary (2.1 GB models) | Medium | Highest (BM25 + vector + LLM reranking) | Production, best recall quality |
| **Orama** | None (pure JS) | Easy | Good (hybrid FTS + vector) | Quick start, no native deps |
| **LanceDB** | Native Arrow bindings | Medium | High (hybrid FTS + vector + RRF) | Large collections, fast vector search |
| **Meilisearch** | Running server | Medium | High (hybrid with server-side embeddings) | Shared search, multi-service |
| **Remote** | HTTP endpoint | Varies | Depends on service | Custom search infrastructure |
| **Noop** | None | None | None | Extraction-only mode |

## QMD (Default)

QMD provides the highest quality retrieval through hybrid BM25 + vector + LLM reranking. It's the default and recommended backend.

### Setup

Install QMD:

```bash
bun install -g github:tobi/qmd
```

Add your memory directory to `~/.config/qmd/index.yml`:

```yaml
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]
```

Index the collection:

```bash
qmd update && qmd embed
```

### Config

```jsonc
{
  "searchBackend": "qmd",        // Default — can be omitted
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram",
  "qmdMaxResults": 8,
  "qmdDaemonEnabled": true       // Keep models warm for fast queries
}
```

### QMD Daemon Mode

For lower latency, enable the QMD HTTP daemon which keeps models loaded in memory:

```bash
qmd mcp --http --daemon
```

With the daemon running, queries drop from ~13 seconds to ~30 milliseconds. Engram automatically detects and uses the daemon when available, falling back to subprocess calls.

| Setting | Default | Description |
|---------|---------|-------------|
| `qmdDaemonEnabled` | `true` | Prefer daemon for search when available |
| `qmdDaemonUrl` | `http://localhost:8181/mcp` | Daemon endpoint |
| `qmdDaemonRecheckIntervalMs` | `60000` | Re-probe interval after failure |

## Orama

Orama is an embedded, pure JavaScript search engine with hybrid FTS + vector support. Zero native dependencies — the easiest backend to get running.

### Config

```jsonc
{
  "searchBackend": "orama"
}
```

That's all you need. Engram handles database creation, document indexing, and persistence automatically.

### How It Works

- Database files stored at `{oramaDbPath}/{collection}.msp` (JSON format)
- `update()` scans your memory directory for `.md` files, diffs against the index, and upserts changes
- `embed()` computes vectors for documents missing them (requires an embedding provider)
- Search modes: fulltext (BM25), vector, or hybrid (combines both)

### Optional Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `oramaDbPath` | `{memoryDir}/orama` | Database storage directory |
| `oramaEmbeddingDimension` | `1536` | Vector dimension (match your embedding model) |

### Embedding Support

For vector and hybrid search, Orama needs an embedding provider. Without one, it falls back to fulltext (BM25) search only.

Configure embedding via the shared embed helper:

```jsonc
{
  "searchBackend": "orama",
  "embeddingFallbackEnabled": true,
  "embeddingFallbackProvider": "auto",   // "openai", "local", or "auto"
  "openaiApiKey": "${OPENAI_API_KEY}"    // For OpenAI embeddings
}
```

## LanceDB

LanceDB is an embedded vector database with native Apache Arrow bindings. It excels at large collections and fast vector similarity search, with built-in RRF (Reciprocal Rank Fusion) reranking for hybrid queries.

### Config

```jsonc
{
  "searchBackend": "lancedb"
}
```

### How It Works

- Database stored at `{lanceDbPath}` directory (Arrow format)
- One table per collection with columns: `docid`, `path`, `content`, `snippet`, `vector`
- Hybrid search combines FTS and vector results with `RRFReranker`
- FTS index auto-created on the `content` column

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lanceDbPath` | `{memoryDir}/lancedb` | Database directory |
| `lanceEmbeddingDimension` | `1536` | Vector dimension |

### Notes

- Requires native bindings (`@lancedb/lancedb`) — may need compilation on some platforms
- Best choice for collections with 10,000+ memories where vector search speed matters
- Embedding configuration is the same as Orama (shared `EmbedHelper`)

## Meilisearch

Meilisearch is a server-based search engine with built-in hybrid search. Use it when you want a shared search service accessible by multiple processes or services.

### Prerequisites

Run a Meilisearch instance:

```bash
docker run -p 7700:7700 getmeili/meilisearch:latest
```

### Config

```jsonc
{
  "searchBackend": "meilisearch",
  "meilisearchHost": "http://localhost:7700",
  "meilisearchAutoIndex": true
}
```

### How It Works

- Connects to a running Meilisearch server via the official SDK
- When `autoIndex` is enabled, `update()` pushes documents from your memory directory to Meilisearch
- Hybrid search uses Meilisearch's built-in embedder (configure on the server side)
- Falls back to BM25-only search if no embedder is configured on the server

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `meilisearchHost` | `http://localhost:7700` | Meilisearch server URL |
| `meilisearchApiKey` | `(none)` | API key for authentication |
| `meilisearchTimeoutMs` | `30000` | Request timeout |
| `meilisearchAutoIndex` | `false` | Auto-push documents on update |

### Meilisearch Embedder Setup

For hybrid/vector search, configure an embedder on your Meilisearch instance:

```bash
curl -X PATCH 'http://localhost:7700/indexes/openclaw-engram/settings' \
  -H 'Content-Type: application/json' \
  --data '{
    "embedders": {
      "default": {
        "source": "openAi",
        "apiKey": "YOUR_KEY",
        "model": "text-embedding-3-small",
        "dimensions": 1536
      }
    }
  }'
```

## Remote

The Remote backend sends search requests to an HTTP REST endpoint. Use it to integrate with custom search infrastructure.

### Config

```jsonc
{
  "searchBackend": "remote",
  "remoteSearchBaseUrl": "https://your-search-service.example.com",
  "remoteSearchApiKey": "your-api-key"
}
```

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `remoteSearchBaseUrl` | `http://localhost:8181` | Search service URL |
| `remoteSearchApiKey` | `(none)` | API key for authentication |
| `remoteSearchTimeoutMs` | `30000` | Request timeout |

## Noop

The Noop backend disables search entirely. Engram still extracts and stores memories, but recall returns no search results. Useful for extraction-only setups or testing.

```jsonc
{
  "searchBackend": "noop"
}
```

## Switching Backends

Switching backends is a config-only change. Your memory files are always plain markdown on disk — no data migration needed.

1. Update `searchBackend` in your config
2. Add any backend-specific settings
3. Restart the gateway: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`
4. Run `openclaw engram stats` to verify the new backend is active

Embedded backends (Orama, LanceDB) will automatically index your existing memory files on the next update cycle.

## Global Search

All backends support `searchGlobal()`, which searches across all collections (not just the default one). This is used by Engram's cross-collection recall when hot/cold tiering or conversation indexing is enabled.

- **QMD**: Searches all configured QMD collections
- **Orama**: Scans all `.msp` files in the database directory
- **LanceDB**: Queries all tables in the database
- **Meilisearch**: Uses `multiSearch` across all server indexes

## See Also

- [Writing a Search Backend](writing-a-search-backend.md) — Implement your own adapter
- [Config Reference](config-reference.md) — All search-related settings
- [Architecture Overview](architecture/overview.md) — How search fits into the recall pipeline
