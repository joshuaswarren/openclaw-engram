import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { GraphDashboardServer } from "../src/dashboard-runtime.js";

function waitForSocketChunk(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk.toString("utf-8"));
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onErr);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("close", onClose);
  });
}

test("dashboard server serves health, graph, static assets, and websocket upgrade", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dashboard-server-"));
  const graphDir = path.join(memoryDir, "state", "graphs");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "entity.jsonl"),
    JSON.stringify({
      from: "facts/2026-02-28/a.md",
      to: "facts/2026-02-28/b.md",
      type: "entity",
      weight: 1,
      label: "project",
      ts: "2026-02-28T10:00:00.000Z",
    }) + "\n",
    "utf-8",
  );

  const server = new GraphDashboardServer({
    memoryDir,
    host: "127.0.0.1",
    port: 0,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
  });
  const started = await server.start();
  assert.equal(started.running, true);
  assert.equal(started.port > 0, true);

  const base = `http://${started.host}:${started.port}`;
  const healthRes = await fetch(`${base}/api/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json() as { ok: boolean };
  assert.equal(health.ok, true);

  const graphRes = await fetch(`${base}/api/graph`);
  assert.equal(graphRes.status, 200);
  const graph = await graphRes.json() as { stats: { edges: number; nodes: number } };
  assert.equal(graph.stats.edges, 1);
  assert.equal(graph.stats.nodes, 2);

  const htmlRes = await fetch(`${base}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.match(html, /Engram Graph Dashboard/);

  const socket = net.createConnection({ host: started.host, port: started.port });
  socket.write(
    [
      "GET / HTTP/1.1",
      `Host: ${started.host}:${started.port}`,
      "Upgrade: WebSocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  const upgradeResponse = await waitForSocketChunk(socket);
  assert.match(upgradeResponse, /101 Switching Protocols/);
  socket.destroy();

  await server.stop();
});

test("dashboard server start recovers after listen failure", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dashboard-server-start-failure-"));
  await mkdir(path.join(memoryDir, "state", "graphs"), { recursive: true });

  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const blockerAddr = blocker.address();
  assert.equal(typeof blockerAddr, "object");
  assert.ok(blockerAddr && typeof blockerAddr.port === "number");

  const server = new GraphDashboardServer({
    memoryDir,
    host: "127.0.0.1",
    port: blockerAddr.port,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
  });

  await assert.rejects(() => server.start());
  const failedStatus = server.status();
  assert.equal(failedStatus.running, false);
  assert.equal(failedStatus.port, 0);

  await new Promise<void>((resolve, reject) => blocker.close((err) => (err ? reject(err) : resolve())));

  const started = await server.start();
  assert.equal(started.running, true);
  assert.equal(started.port > 0, true);
  await server.stop();
});
