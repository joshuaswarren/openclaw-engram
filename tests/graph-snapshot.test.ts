/**
 * Tests for the graph snapshot HTTP surface (issue #691 PR 2/5).
 *
 * Covers:
 *   - the pure `buildGraphSnapshot` builder against a fixture memory dir,
 *   - the `EngramAccessHttpServer` route (auth, query-param validation,
 *     focus / category filters, limit enforcement),
 *   - the dual MCP tool name (`engram.graph_snapshot` /
 *     `remnic.graph_snapshot`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import * as path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

import { EngramAccessHttpServer } from "../src/access-http.js";
import type { EngramAccessService } from "../src/access-service.js";
import {
  buildGraphSnapshot,
  GRAPH_SNAPSHOT_DEFAULT_LIMIT,
  GRAPH_SNAPSHOT_MAX_LIMIT,
  normalizeGraphSnapshotLimit,
  parseGraphSnapshotSince,
  type GraphSnapshotResponse,
} from "../src/graph-snapshot.js";
import { appendEdge } from "../src/graph.js";
import { EngramMcpServer } from "../src/access-mcp.js";

async function makeFixtureDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "engram-graph-snapshot-test-"));
}

async function seedEdges(memoryDir: string): Promise<void> {
  const ts = (offset: number): string =>
    new Date(Date.UTC(2026, 3, 20, 12, offset)).toISOString();
  await appendEdge(memoryDir, {
    from: "facts/2026-04-20/alpha.md",
    to: "facts/2026-04-20/beta.md",
    type: "entity",
    weight: 1.0,
    label: "project-x",
    ts: ts(0),
    confidence: 0.9,
  });
  await appendEdge(memoryDir, {
    from: "facts/2026-04-20/beta.md",
    to: "facts/2026-04-20/gamma.md",
    type: "entity",
    weight: 1.0,
    label: "project-x",
    ts: ts(5),
    confidence: 0.8,
  });
  await appendEdge(memoryDir, {
    from: "decisions/2026-04-20/d1.md",
    to: "facts/2026-04-20/alpha.md",
    type: "causal",
    weight: 1.0,
    label: "because",
    ts: ts(10),
  });
}

const META_FIXTURE: Record<string, { category: string; label: string; updated: string }> = {
  "facts/2026-04-20/alpha.md": {
    category: "fact",
    label: "alpha",
    updated: "2026-04-20T12:00:00.000Z",
  },
  "facts/2026-04-20/beta.md": {
    category: "fact",
    label: "beta",
    updated: "2026-04-20T12:05:00.000Z",
  },
  "facts/2026-04-20/gamma.md": {
    category: "fact",
    label: "gamma",
    updated: "2026-04-20T12:05:00.000Z",
  },
  "decisions/2026-04-20/d1.md": {
    category: "decision",
    label: "d1",
    updated: "2026-04-20T12:10:00.000Z",
  },
};

function buildLoader() {
  return async (relPath: string) => META_FIXTURE[relPath] ?? null;
}

test("normalizeGraphSnapshotLimit defaults / clamps / rejects", () => {
  assert.equal(normalizeGraphSnapshotLimit(undefined), GRAPH_SNAPSHOT_DEFAULT_LIMIT);
  assert.equal(normalizeGraphSnapshotLimit(50), 50);
  assert.equal(
    normalizeGraphSnapshotLimit(GRAPH_SNAPSHOT_MAX_LIMIT + 100),
    GRAPH_SNAPSHOT_MAX_LIMIT,
  );
  assert.throws(() => normalizeGraphSnapshotLimit(0), /positive integer/);
  assert.throws(() => normalizeGraphSnapshotLimit(-3), /positive integer/);
  assert.throws(() => normalizeGraphSnapshotLimit(1.5), /positive integer/);
  assert.throws(() => normalizeGraphSnapshotLimit("50" as unknown), /positive integer/);
});

test("parseGraphSnapshotSince accepts ISO and rejects garbage", () => {
  assert.equal(parseGraphSnapshotSince(undefined), undefined);
  assert.equal(parseGraphSnapshotSince(""), undefined);
  const ms = parseGraphSnapshotSince("2026-04-20T12:00:00Z");
  assert.equal(typeof ms, "number");
  assert.throws(() => parseGraphSnapshotSince("not-a-date"), /ISO/);
});

test("buildGraphSnapshot returns nodes/edges from a fixture memory dir", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
      },
      request: {},
      loadNode: buildLoader(),
    });
    assert.equal(snapshot.edges.length, 3);
    // Node count = 4 (alpha, beta, gamma, d1).
    assert.equal(snapshot.nodes.length, 4);
    // Edges include the canonical fields.
    const first = snapshot.edges[0]!;
    assert.ok(typeof first.source === "string");
    assert.ok(typeof first.target === "string");
    assert.match(first.kind, /^(entity|time|causal)$/);
    assert.ok(first.confidence > 0 && first.confidence <= 1);
    // generatedAt is an ISO string.
    assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)));
    // Nodes carry resolved label / kind / score.
    const beta = snapshot.nodes.find((n) => n.id === "facts/2026-04-20/beta.md");
    assert.ok(beta);
    assert.equal(beta!.label, "beta");
    assert.equal(beta!.kind, "fact");
    assert.ok(beta!.score > 0);
    assert.ok(beta!.lastUpdated && !Number.isNaN(Date.parse(beta!.lastUpdated)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot enforces limit", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
      },
      request: { limit: 1 },
      loadNode: buildLoader(),
    });
    assert.equal(snapshot.edges.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot focusNodeId returns only neighborhood", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
      },
      request: { focusNodeId: "facts/2026-04-20/alpha.md" },
      loadNode: buildLoader(),
    });
    // alpha appears in edges 1 (alpha->beta) and 3 (d1->alpha) — both incident.
    assert.equal(snapshot.edges.length, 2);
    for (const edge of snapshot.edges) {
      assert.ok(
        edge.source === "facts/2026-04-20/alpha.md" || edge.target === "facts/2026-04-20/alpha.md",
        `edge ${edge.source}->${edge.target} should touch focus node`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot categories filter requires both endpoints to match", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
      },
      request: { categories: ["fact"] },
      loadNode: buildLoader(),
    });
    // Only the two fact↔fact entity edges survive; the decision↔fact causal
    // edge is dropped because `decision` is outside the allow-list.
    assert.equal(snapshot.edges.length, 2);
    for (const edge of snapshot.edges) {
      assert.equal(edge.kind, "entity");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot since filter drops older edges", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraphEnabled: true,
        timeGraphEnabled: true,
        causalGraphEnabled: true,
      },
      request: { since: "2026-04-20T12:08:00Z" },
      loadNode: buildLoader(),
    });
    // Only the 12:10 causal edge passes the cutoff.
    assert.equal(snapshot.edges.length, 1);
    assert.equal(snapshot.edges[0]!.kind, "causal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot rejects empty categories array", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    await assert.rejects(
      buildGraphSnapshot({
        memoryDir: dir,
        graphConfig: {
          entityGraphEnabled: true,
          timeGraphEnabled: true,
          causalGraphEnabled: true,
        },
        request: { categories: [] },
        loadNode: buildLoader(),
      }),
      /at least one non-empty value/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP surface tests
// ─────────────────────────────────────────────────────────────────────────────

function createFakeService(overrides: Partial<EngramAccessService> = {}): EngramAccessService {
  return {
    graphSnapshot: async (request: { limit?: number; namespace?: string }) => ({
      nodes: [
        {
          id: "facts/2026-04-20/alpha.md",
          label: "alpha",
          kind: "fact",
          score: 0.9,
          lastUpdated: "2026-04-20T12:00:00.000Z",
        },
      ],
      edges: [
        {
          source: "facts/2026-04-20/alpha.md",
          target: "facts/2026-04-20/beta.md",
          kind: "entity" as const,
          confidence: 0.9,
        },
      ],
      generatedAt: "2026-04-20T12:30:00.000Z",
      ...(request.limit !== undefined ? { _capturedLimit: request.limit } : {}),
      ...(request.namespace !== undefined ? { _capturedNamespace: request.namespace } : {}),
    }),
    ...overrides,
  } as unknown as EngramAccessService;
}

test("HTTP /engram/v1/graph/snapshot rejects unauthenticated requests", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(`http://${started.host}:${started.port}/engram/v1/graph/snapshot`);
    assert.equal(res.status, 401);
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot returns nodes and edges", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(
      `http://${started.host}:${started.port}/engram/v1/graph/snapshot`,
      { headers: { Authorization: "Bearer secret-token" } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as GraphSnapshotResponse;
    assert.equal(body.edges.length, 1);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.edges[0]!.source, "facts/2026-04-20/alpha.md");
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot rejects invalid limit", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(
      `http://${started.host}:${started.port}/engram/v1/graph/snapshot?limit=abc`,
      { headers: { Authorization: "Bearer secret-token" } },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "invalid_limit");
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot rejects invalid since", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(
      `http://${started.host}:${started.port}/engram/v1/graph/snapshot?since=not-a-date`,
      { headers: { Authorization: "Bearer secret-token" } },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "invalid_since");
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot rejects empty categories list", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(
      `http://${started.host}:${started.port}/engram/v1/graph/snapshot?categories=,,,`,
      { headers: { Authorization: "Bearer secret-token" } },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "invalid_categories");
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot forwards filters to the service", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const service = createFakeService({
    graphSnapshot: async (request: Record<string, unknown>) => {
      captured.push(request);
      return {
        nodes: [],
        edges: [],
        generatedAt: "2026-04-20T12:30:00.000Z",
      };
    },
  } as unknown as Partial<EngramAccessService>);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const url = `http://${started.host}:${started.port}/engram/v1/graph/snapshot`
      + `?limit=42&since=2026-04-20T00:00:00Z&focusNodeId=facts%2Falpha.md`
      + `&categories=fact,decision`;
    const res = await fetch(url, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(res.status, 200);
    assert.equal(captured.length, 1);
    const args = captured[0]!;
    assert.equal(args.limit, 42);
    assert.equal(args.since, "2026-04-20T00:00:00Z");
    assert.equal(args.focusNodeId, "facts/alpha.md");
    assert.deepEqual(args.categories, ["fact", "decision"]);
  } finally {
    await server.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP surface tests
// ─────────────────────────────────────────────────────────────────────────────

test("MCP graph_snapshot tool is exposed under both prefixes", async () => {
  const service = createFakeService();
  const mcp = new EngramMcpServer(service);
  const init = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.ok(init);
  const tools = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const listed = (tools?.result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );
  assert.ok(
    listed.includes("engram.graph_snapshot"),
    `expected engram.graph_snapshot in ${listed.join(",")}`,
  );
  assert.ok(
    listed.includes("remnic.graph_snapshot"),
    `expected remnic.graph_snapshot in ${listed.join(",")}`,
  );
});

test("MCP graph_snapshot tool dispatches to the service", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const service = createFakeService({
    graphSnapshot: async (request: Record<string, unknown>) => {
      captured.push(request);
      return {
        nodes: [],
        edges: [],
        generatedAt: "2026-04-20T12:30:00.000Z",
      };
    },
  } as unknown as Partial<EngramAccessService>);
  const mcp = new EngramMcpServer(service);
  await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  const result = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "engram.graph_snapshot",
      arguments: {
        limit: 100,
        since: "2026-04-20T00:00:00Z",
        focusNodeId: "facts/x.md",
        categories: ["fact"],
      },
    },
  });
  assert.ok(result?.result);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.limit, 100);
  assert.deepEqual(captured[0]!.categories, ["fact"]);
});

test("MCP graph_snapshot rejects non-numeric limit at the boundary", async () => {
  const service = createFakeService();
  const mcp = new EngramMcpServer(service);
  await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  const result = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "engram.graph_snapshot",
      arguments: { limit: "100" },
    },
  });
  // Errors are surfaced via the standard MCP error envelope.
  assert.ok(result);
  const wrapped = result as { result?: { isError?: boolean }; error?: unknown };
  // Either MCP error or `isError: true` content is acceptable; we just need
  // the boundary to NOT silently coerce.
  if (wrapped.error === undefined) {
    assert.equal(wrapped.result?.isError, true);
  }
});

// Suppress unused-import warning for `mkdir` / `writeFile` (kept for future
// fixture extensions that exercise the orchestrator-backed loader).
void mkdir;
void writeFile;
