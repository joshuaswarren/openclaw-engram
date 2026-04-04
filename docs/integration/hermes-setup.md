# Hermes Integration Guide

Connect an LLM agent to Engram via HTTP.

 Hermes is a lightweight HTTP client for connecting LLM agents to Engram's memory system without requiring a full Engram installation.

## Why Hermes?

Hermes is designed for external tool integration. It It works alongside existing OpenClaw plugins, via HTTP calls, — no filesystem access, daemon, or native library dependency.

## Installation

### As a standalone npm package (v9.1.36+)

Hermes is available as `@engram/hermes-provider` for use in any Node.js project:

```bash
npm install @engram/hermes-provider
```

### Alternative: via the Engram CLI

If you have the `engram` CLI installed, you can use `engram daemon start` to launch the server that Hermes connects to, rather than running `openclaw engram access http-serve` manually.

## Quick Start

1. Install the package:
```bash
npm install @engram/hermes-provider
# or
bun
# or
```

2. Configure the client:
```typescript
import { HermesClient } from "@engram/hermes-provider";

const client = new HermesClient({
  baseUrl: "http://127.0.0.1:4318",
  authToken: "your-secret-token-here",
});
```

3. Start using:
```typescript
// Check health
const health = await client.health();
console.log(health);
// { ok: true, memoryDir: "...", ... }

// Recall memories
const recallResult = await client.recall("What did the Python last week?");
console.log(recallResult.context);

console.log(`${recallResult.count} memories recalled`);
```

### Example: Observe (feed conversation)
```typescript
const messages = [
  { role: "user", content: "Remember that I prefer dark mode" },
  { role: "assistant", content: "Noted. Use dark mode." },
];

const observeResult = await client.observe({
  sessionKey: "my-session-2024-04-03",
  messages,
});
console.log(observeResult);
// { accepted: 2, sessionKey: "my-session-2024-04-03", ... }
```

### API Methods
| Method | Description | Returns |
|--------|-------------|---------|
| `health()` | Check server health | `EngramAccessHealthResponse` |
| `recall(query, options?)` | Recall memories | `EngramAccessRecallResponse` |
| `observe(sessionKey, messages, options?)` | Feed conversation | `EngramAccessObserveResponse` |
| `store(request)` | Store a memory | `EngramAccessWriteResponse` |
| `getEntities(options?)` | List entities | `EngramAccessEntityListResponse` |

## Standalone Usage

The `@engram/hermes-provider` package can be used without any Engram installation. Point it at any running Engram HTTP server:

```typescript
import { HermesClient } from "@engram/hermes-provider";

const client = new HermesClient({
  baseUrl: "https://engram.example.com",  // remote Engram instance
  authToken: process.env.ENGRAM_TOKEN,
});

const results = await client.recall("project decisions");
```

This is useful for:
- Connecting scripts and automation to a shared Engram instance
- Building custom agent integrations without the full Engram engine
- Connecting to a remote Engram server managed by another team

## Error Handling
Hermes retries failed requests with exponential backoff (default: 3 retries, 100ms delay). 429/529/1s timeout). 500 errors throw after 10 retries. Connection errors are logged. Graceful degradation -- returns empty results or null for the unknown errors.

## TypeScript Support
Works with any TypeScript project. Types are inferred from the response schemas.
