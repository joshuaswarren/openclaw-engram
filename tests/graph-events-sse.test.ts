/**
 * Tests for real-time SSE graph events (issue #691 PR 5/5).
 *
 * Covers:
 *  1. emitGraphEvent() reaches subscribeGraphEvents() listener.
 *  2. appendEdge() automatically emits an "edge-added" event.
 *  3. GET /engram/v1/graph/events returns 200 text/event-stream.
 *  4. An "edge-added" event emitted after connection appears in the stream.
 *  5. 401 when auth token is missing or wrong.
 *  6. ?token= query-parameter auth accepted (EventSource path).
 *  7. destroyGraphEventBus() cleans up listener set so subsequent tests start fresh.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import * as path from "node:path";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";

import {
  emitGraphEvent,
  subscribeGraphEvents,
  destroyGraphEventBus,
  type GraphEvent,
} from "../src/graph-events.js";
import { appendEdge } from "../src/graph.js";
import { EngramAccessHttpServer } from "../src/access-http.js";
import type { EngramAccessService } from "../src/access-service.js";

// ---------------------------------------------------------------------------
// Minimal fake service (sufficient for the SSE route)
// ---------------------------------------------------------------------------

function makeFakeService(memoryDir: string): EngramAccessService {
  // We only need the memoryDir getter for the SSE handler.
  return {
    memoryDir,
    health: async () => ({
      ok: true,
      memoryDir,
      namespacesEnabled: false,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: false,
      nativeKnowledgeEnabled: false,
      projectionAvailable: false,
    }),
    // All other methods are not exercised in these tests.
  } as unknown as EngramAccessService;
}

// ---------------------------------------------------------------------------
// Helper: collect N SSE data frames from an HTTP response stream.
// ---------------------------------------------------------------------------

function collectSseFrames(
  options: http.RequestOptions,
  n: number,
  timeoutMs = 3000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const frames: unknown[] = [];
    const timer = setTimeout(() => {
      req.destroy();
      if (frames.length >= n) {
        resolve(frames.slice(0, n));
      } else {
        reject(new Error(`SSE timeout: collected ${frames.length} frames, expected ${n}`));
      }
    }, timeoutMs);

    const req = http.request(options, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              frames.push(JSON.parse(trimmed.slice(6)));
            } catch {
              // ignore non-JSON lines
            }
            if (frames.length >= n) {
              clearTimeout(timer);
              req.destroy();
              resolve(frames.slice(0, n));
              return;
            }
          }
        }
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        // Ignore ECONNRESET from req.destroy() once we have enough frames
        if (frames.length >= n) {
          resolve(frames.slice(0, n));
        } else {
          reject(err);
        }
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      if (frames.length >= n) {
        resolve(frames.slice(0, n));
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Unit tests: graph-events module
// ---------------------------------------------------------------------------

test("emitGraphEvent reaches subscribeGraphEvents listener", () => {
  const dir = "/tmp/engram-test-emit-" + Date.now();
  try {
    const received: GraphEvent[] = [];
    const unsub = subscribeGraphEvents(dir, (e) => received.push(e));
    emitGraphEvent(dir, "edge-added", { source: "a.md", target: "b.md", kind: "entity" });
    unsub();
    assert.equal(received.length, 1);
    assert.equal(received[0]!.type, "edge-added");
    assert.equal((received[0]!.payload as Record<string, unknown>).source, "a.md");
    assert.equal(received[0]!.memoryDir, dir);
    assert.ok(!Number.isNaN(Date.parse(received[0]!.ts)));
  } finally {
    destroyGraphEventBus(dir);
  }
});

test("subscribeGraphEvents unsubscribe prevents further delivery", () => {
  const dir = "/tmp/engram-test-unsub-" + Date.now();
  try {
    const received: GraphEvent[] = [];
    const unsub = subscribeGraphEvents(dir, (e) => received.push(e));
    unsub();
    emitGraphEvent(dir, "edge-added", { source: "x.md", target: "y.md" });
    assert.equal(received.length, 0);
  } finally {
    destroyGraphEventBus(dir);
  }
});

test("destroyGraphEventBus removes all listeners", () => {
  const dir = "/tmp/engram-test-destroy-" + Date.now();
  const received: GraphEvent[] = [];
  subscribeGraphEvents(dir, (e) => received.push(e));
  destroyGraphEventBus(dir);
  emitGraphEvent(dir, "edge-added", { source: "a.md", target: "b.md" });
  // emitGraphEvent recreates a fresh bus after destroy; old listener not attached
  assert.equal(received.length, 0);
  destroyGraphEventBus(dir);
});

test("appendEdge emits edge-added event on the graph event bus", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-append-edge-"));
  try {
    const received: GraphEvent[] = [];
    const unsub = subscribeGraphEvents(dir, (e) => received.push(e));
    await appendEdge(dir, {
      from: "facts/a.md",
      to: "facts/b.md",
      type: "entity",
      weight: 1.0,
      label: "test-entity",
      ts: new Date().toISOString(),
      confidence: 0.9,
    });
    unsub();
    assert.equal(received.length, 1);
    const ev = received[0]!;
    assert.equal(ev.type, "edge-added");
    assert.equal((ev.payload as Record<string, unknown>).source, "facts/a.md");
    assert.equal((ev.payload as Record<string, unknown>).target, "facts/b.md");
    assert.equal((ev.payload as Record<string, unknown>).kind, "entity");
    assert.equal((ev.payload as Record<string, unknown>).confidence, 0.9);
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP / SSE integration tests
// ---------------------------------------------------------------------------

async function startTestServer(memoryDir: string, token = "test-token") {
  const service = makeFakeService(memoryDir);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: token,
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  return { server, port: status.port };
}

test("GET /engram/v1/graph/events returns 200 text/event-stream", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-headers-"));
  try {
    const { server, port } = await startTestServer(dir);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/engram/v1/graph/events",
            headers: { Authorization: "Bearer test-token" },
          },
          (res) => {
            assert.equal(res.statusCode, 200);
            assert.ok(
              res.headers["content-type"]?.includes("text/event-stream"),
              `expected text/event-stream, got ${res.headers["content-type"]}`,
            );
            req.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /engram/v1/graph/events returns 401 with wrong token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-unauth-"));
  try {
    const { server, port } = await startTestServer(dir, "correct-token");
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/engram/v1/graph/events",
            headers: { Authorization: "Bearer wrong-token" },
          },
          (res) => {
            assert.equal(res.statusCode, 401);
            req.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /engram/v1/graph/events accepts ?token= query parameter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-qtoken-"));
  try {
    const { server, port } = await startTestServer(dir, "qtoken-secret");
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/engram/v1/graph/events?token=qtoken-secret",
            // No Authorization header — browser EventSource path
          },
          (res) => {
            assert.equal(res.statusCode, 200);
            assert.ok(
              res.headers["content-type"]?.includes("text/event-stream"),
            );
            req.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge-added event emitted after connection appears in the SSE stream", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-event-"));
  try {
    const { server, port } = await startTestServer(dir, "stream-token");
    try {
      // Collect the first two frames: "connected" + a batch with edge-added.
      const framesPromise = collectSseFrames(
        {
          host: "127.0.0.1",
          port,
          path: "/engram/v1/graph/events",
          headers: { Authorization: "Bearer stream-token" },
        },
        2, // connected frame + one batch frame
      );

      // Wait a tick for the SSE connection to be established before emitting.
      await new Promise<void>((r) => setTimeout(r, 50));

      // Emit directly via the event bus (avoids needing a full storage setup).
      emitGraphEvent(dir, "edge-added", {
        source: "facts/p.md",
        target: "facts/q.md",
        kind: "entity",
        weight: 1.0,
        label: "test",
        confidence: 1.0,
      });

      const frames = await framesPromise;

      // First frame must be "connected"
      const first = frames[0] as Record<string, unknown>;
      assert.equal(first.type, "connected");

      // Second frame should be a batch containing our edge-added event.
      const second = frames[1] as Record<string, unknown>;
      assert.equal(second.type, "batch");
      const events = second.events as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(events) && events.length >= 1);
      const edgeEvent = events.find((e) => e.type === "edge-added");
      assert.ok(edgeEvent, "expected edge-added event in batch");
      assert.equal(
        (edgeEvent!.payload as Record<string, unknown>).source,
        "facts/p.md",
      );
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});
