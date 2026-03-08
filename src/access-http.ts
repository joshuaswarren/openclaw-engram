import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { log } from "./logger.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";

export interface EngramAccessHttpServerOptions {
  service: EngramAccessService;
  host?: string;
  port?: number;
  authToken?: string;
  maxBodyBytes?: number;
}

export interface EngramAccessHttpServerStatus {
  running: boolean;
  host: string;
  port: number;
  maxBodyBytes: number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function hostToUrlAuthority(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

export class EngramAccessHttpServer {
  private readonly service: EngramAccessService;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly authToken?: string;
  private readonly maxBodyBytes: number;
  private server: Server | null = null;
  private boundPort = 0;

  constructor(options: EngramAccessHttpServerOptions) {
    this.service = options.service;
    this.host = options.host?.trim() || "127.0.0.1";
    this.requestedPort = Number.isFinite(options.port) ? Math.max(0, Math.floor(options.port ?? 0)) : 0;
    this.authToken = options.authToken?.trim() || undefined;
    this.maxBodyBytes = Number.isFinite(options.maxBodyBytes)
      ? Math.max(1, Math.floor(options.maxBodyBytes ?? 131072))
      : 131072;
  }

  async start(): Promise<EngramAccessHttpServerStatus> {
    if (!this.authToken) {
      throw new Error("engram access HTTP requires authToken");
    }
    if (this.server) return this.status();

    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        log.debug(`engram access HTTP request failed: ${err}`);
        if (err instanceof HttpError) {
          this.respondJson(res, err.status, { error: err.message });
          return;
        }
        if (err instanceof EngramAccessInputError) {
          this.respondJson(res, 400, { error: err.message });
          return;
        }
        if (res.headersSent) {
          res.destroy(err as Error);
          return;
        }
        this.respondJson(res, 500, { error: "internal_error" });
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.requestedPort, this.host);
      });
    } catch (err) {
      server.close();
      throw err;
    }

    this.server = server;
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.requestedPort;
    return this.status();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  status(): EngramAccessHttpServerStatus {
    return {
      running: this.server !== null,
      host: this.host,
      port: this.boundPort,
      maxBodyBytes: this.maxBodyBytes,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": "Bearer",
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.host)}`);
    const pathname = parsed.pathname;

    if (req.method === "GET" && pathname === "/engram/v1/health") {
      this.respondJson(res, 200, await this.service.health());
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/recall") {
      const body = await this.readJsonBody(req);
      const response = await this.service.recall({
        query: typeof body.query === "string" ? body.query : "",
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/recall/explain") {
      const body = await this.readJsonBody(req);
      const response = await this.service.recallExplain({
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
      });
      this.respondJson(res, 200, response);
      return;
    }

    const memoryMatch = pathname.match(/^\/engram\/v1\/memories\/([^/]+)$/);
    if (req.method === "GET" && memoryMatch) {
      const memoryId = decodeURIComponent(memoryMatch[1] ?? "");
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const response = await this.service.memoryGet(memoryId, namespace);
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    const timelineMatch = pathname.match(/^\/engram\/v1\/memories\/([^/]+)\/timeline$/);
    if (req.method === "GET" && timelineMatch) {
      const memoryId = decodeURIComponent(timelineMatch[1] ?? "");
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "200", 10);
      const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
      const response = await this.service.memoryTimeline(memoryId, namespace, limit);
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    this.respondJson(res, 404, { error: "not_found" });
  }

  private respondJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", String(Buffer.byteLength(body)));
    res.end(body);
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > this.maxBodyBytes) {
        throw new HttpError(413, "request_body_too_large");
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "invalid_json_object");
    }
    return parsed as Record<string, unknown>;
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.authToken) return false;
    const raw = req.headers.authorization;
    if (!raw) return false;
    const separator = raw.indexOf(" ");
    if (separator <= 0) return false;
    const scheme = raw.slice(0, separator).toLowerCase();
    if (scheme !== "bearer") return false;
    const token = raw.slice(separator + 1).trim();
    return this.timingSafeStringEqual(token, this.authToken);
  }

  private timingSafeStringEqual(a: string, b: string): boolean {
    const left = this.encodeSecret(a);
    const right = this.encodeSecret(b);
    if (!left || !right) return false;
    return timingSafeEqual(left, right);
  }

  private encodeSecret(value: string): Buffer | null {
    const encoded = Buffer.from(value, "utf-8");
    if (encoded.length > 1024) return null;
    const out = Buffer.alloc(2 + 1024);
    out.writeUInt16BE(encoded.length, 0);
    encoded.copy(out, 2);
    return out;
  }
}
