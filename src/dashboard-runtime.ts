import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import { graphSnapshotFromMemoryDir, type GraphSnapshot } from "./graph-dashboard-parser.js";
import { diffGraphSnapshots } from "./graph-dashboard-diff.js";

export interface DashboardServerOptions {
  memoryDir: string;
  host?: string;
  port?: number;
  publicDir?: string;
  watchDebounceMs?: number;
}

export interface DashboardStatus {
  running: boolean;
  host: string;
  port: number;
  watching: boolean;
  lastUpdatedAt?: string;
  graphNodeCount: number;
  graphEdgeCount: number;
}

type WsClient = {
  id: string;
  socket: Duplex;
};

function websocketAcceptKey(clientKey: string): string {
  return createHash("sha1")
    .update(`${clientKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeTextFrame(payload: string): Buffer {
  const payloadBuffer = Buffer.from(payload, "utf-8");
  const len = payloadBuffer.length;
  const header: number[] = [0x81];
  if (len <= 125) {
    header.push(len);
  } else if (len <= 0xffff) {
    header.push(126, (len >> 8) & 0xff, len & 0xff);
  } else {
    const high = Math.floor(len / 2 ** 32);
    const low = len >>> 0;
    header.push(127, 0, 0, 0, 0, (high >> 24) & 0xff, (high >> 16) & 0xff, (high >> 8) & 0xff, high & 0xff, (low >> 24) & 0xff, (low >> 16) & 0xff, (low >> 8) & 0xff, low & 0xff);
  }
  return Buffer.concat([Buffer.from(header), payloadBuffer]);
}

export class GraphDashboardServer {
  private readonly memoryDir: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly publicDir: string;
  private readonly watchDebounceMs: number;
  private server: ReturnType<typeof createServer> | null = null;
  private watcher: FSWatcher | null = null;
  private clients = new Map<string, WsClient>();
  private graphSnapshot: GraphSnapshot = {
    generatedAt: new Date(0).toISOString(),
    nodes: [],
    edges: [],
    stats: { nodes: 0, edges: 0, malformedLines: 0, filesMissing: [] },
  };
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private boundPort = 0;

  constructor(options: DashboardServerOptions) {
    this.memoryDir = options.memoryDir;
    this.host = options.host?.trim() || "127.0.0.1";
    this.requestedPort = Number.isFinite(options.port) ? Math.max(0, Math.floor(options.port ?? 0)) : 0;
    this.publicDir = options.publicDir ?? path.join(process.cwd(), "dashboard", "public");
    this.watchDebounceMs = Math.max(50, Math.floor(options.watchDebounceMs ?? 300));
  }

  async start(): Promise<DashboardStatus> {
    if (this.server) {
      return this.status();
    }

    await this.rebuildSnapshot();
    this.server = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.server.on("upgrade", (req, socket) => {
      this.handleUpgrade(req, socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.requestedPort, this.host, () => resolve());
    });
    const addr = this.server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.requestedPort;
    this.startWatcher();
    return this.status();
  }

  async stop(): Promise<void> {
    const closeServer = this.server;
    this.server = null;
    this.boundPort = 0;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const client of this.clients.values()) {
      try {
        client.socket.destroy();
      } catch {
        // no-op
      }
    }
    this.clients.clear();

    if (closeServer) {
      await new Promise<void>((resolve, reject) => {
        closeServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  status(): DashboardStatus {
    return {
      running: this.server !== null,
      host: this.host,
      port: this.boundPort,
      watching: this.watcher !== null,
      lastUpdatedAt: this.graphSnapshot.generatedAt,
      graphNodeCount: this.graphSnapshot.stats.nodes,
      graphEdgeCount: this.graphSnapshot.stats.edges,
    };
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/api/health") {
      this.respondJson(res, 200, {
        ok: true,
        running: this.server !== null,
        watching: this.watcher !== null,
        graph: this.graphSnapshot.stats,
        clients: this.clients.size,
        lastError: this.lastError ?? undefined,
      });
      return;
    }
    if (req.method === "GET" && url === "/api/graph") {
      this.respondJson(res, 200, this.graphSnapshot);
      return;
    }
    if (req.method === "GET" && url === "/app.js") {
      await this.respondStatic(res, path.join(this.publicDir, "app.js"), "application/javascript; charset=utf-8");
      return;
    }
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      await this.respondStatic(res, path.join(this.publicDir, "index.html"), "text/html; charset=utf-8");
      return;
    }
    this.respondJson(res, 404, { error: "Not found" });
  }

  private respondJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", String(Buffer.byteLength(body)));
    res.end(body);
  }

  private async respondStatic(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
    try {
      const body = await readFile(filePath, "utf-8");
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("content-length", String(Buffer.byteLength(body)));
      res.end(body);
    } catch {
      this.respondJson(res, 404, { error: "Not found" });
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
    const upgrade = req.headers.upgrade;
    const key = req.headers["sec-websocket-key"];
    if (upgrade !== "websocket" || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = websocketAcceptKey(key);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.clients.set(id, { id, socket });
    socket.on("close", () => {
      this.clients.delete(id);
    });
    socket.on("error", () => {
      this.clients.delete(id);
    });

    const hello = JSON.stringify({
      type: "hello",
      graph: this.graphSnapshot,
    });
    socket.write(encodeTextFrame(hello));
  }

  private broadcast(payload: unknown): void {
    const frame = encodeTextFrame(JSON.stringify(payload));
    for (const [id, client] of this.clients.entries()) {
      try {
        client.socket.write(frame);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  private startWatcher(): void {
    const graphDir = path.join(this.memoryDir, "state", "graphs");
    try {
      this.watcher = watch(graphDir, { persistent: false }, () => {
        this.scheduleRebuild();
      });
      this.watcher.on("error", (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.watcher = null;
    }
  }

  private scheduleRebuild(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.rebuildAndBroadcast();
    }, this.watchDebounceMs);
  }

  private async rebuildAndBroadcast(): Promise<void> {
    const previous = this.graphSnapshot;
    await this.rebuildSnapshot();
    const patch = diffGraphSnapshots(previous, this.graphSnapshot);
    if (patch.addedEdges.length === 0 && patch.removedEdges.length === 0 && patch.addedNodes.length === 0 && patch.removedNodes.length === 0) {
      return;
    }
    this.broadcast({
      type: "graph_patch",
      generatedAt: new Date().toISOString(),
      patch,
      graph: this.graphSnapshot,
    });
  }

  private async rebuildSnapshot(): Promise<void> {
    try {
      this.graphSnapshot = await graphSnapshotFromMemoryDir(this.memoryDir);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
