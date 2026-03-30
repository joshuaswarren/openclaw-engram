import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { log } from "./logger.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import { EngramMcpServer } from "./access-mcp.js";
import type { RecallPlanMode } from "./types.js";
import { isTrustZoneName, type TrustZoneName, type TrustZoneRecordKind, type TrustZoneSourceClass } from "./trust-zones.js";

export interface EngramAccessHttpServerOptions {
  service: EngramAccessService;
  host?: string;
  port?: number;
  authToken?: string;
  principal?: string;
  maxBodyBytes?: number;
  adminConsoleEnabled?: boolean;
  adminConsolePublicDir?: string;
  trustPrincipalHeader?: boolean;
}

export interface EngramAccessHttpServerStatus {
  running: boolean;
  host: string;
  port: number;
  maxBodyBytes: number;
}

function resolveDefaultAdminConsolePublicDir(): string {
  const candidates = [
    fileURLToPath(new URL("../admin-console/public", import.meta.url)),
    fileURLToPath(new URL("./admin-console/public", import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const defaultAdminConsolePublicDir = resolveDefaultAdminConsolePublicDir();
const WRITE_RATE_LIMIT_WINDOW_MS = 60_000;
const WRITE_RATE_LIMIT_MAX_REQUESTS = 30;
const TRUST_ZONE_RECORD_KINDS = ["memory", "artifact", "state", "trajectory", "external"] as const;
const TRUST_ZONE_SOURCE_CLASSES = ["tool_output", "web_content", "subagent_trace", "system_memory", "user_input", "manual"] as const;

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

function parseTrustZoneKindFilter(raw: string | null): TrustZoneRecordKind | undefined {
  if (raw === null) return undefined;
  if ((TRUST_ZONE_RECORD_KINDS as readonly string[]).includes(raw)) {
    return raw as TrustZoneRecordKind;
  }
  throw new HttpError(400, `kind must be one of ${TRUST_ZONE_RECORD_KINDS.join("|")}`);
}

function parseTrustZoneSourceClassFilter(raw: string | null): TrustZoneSourceClass | undefined {
  if (raw === null) return undefined;
  if ((TRUST_ZONE_SOURCE_CLASSES as readonly string[]).includes(raw)) {
    return raw as TrustZoneSourceClass;
  }
  throw new HttpError(400, `sourceClass must be one of ${TRUST_ZONE_SOURCE_CLASSES.join("|")}`);
}

function parseTrustZoneFilter(raw: string | null): TrustZoneName | undefined {
  if (raw === null) return undefined;
  if (isTrustZoneName(raw)) {
    return raw;
  }
  throw new HttpError(400, "zone must be one of quarantine|working|trusted");
}

export class EngramAccessHttpServer {
  private readonly service: EngramAccessService;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly authToken?: string;
  private readonly authenticatedPrincipal?: string;
  private readonly maxBodyBytes: number;
  private readonly adminConsoleEnabled: boolean;
  private readonly adminConsolePublicDir: string;
  private readonly trustPrincipalHeader: boolean;
  private readonly writeRequestTimestamps: number[] = [];
  private readonly mcpServer: EngramMcpServer;
  private server: Server | null = null;
  private boundPort = 0;

  constructor(options: EngramAccessHttpServerOptions) {
    this.service = options.service;
    this.host = options.host?.trim() || "127.0.0.1";
    this.requestedPort = Number.isFinite(options.port) ? Math.max(0, Math.floor(options.port ?? 0)) : 0;
    this.authToken = options.authToken?.trim() || undefined;
    this.authenticatedPrincipal = options.principal?.trim() || undefined;
    this.maxBodyBytes = Number.isFinite(options.maxBodyBytes)
      ? Math.max(1, Math.floor(options.maxBodyBytes ?? 131072))
      : 131072;
    this.adminConsoleEnabled = options.adminConsoleEnabled !== false;
    this.adminConsolePublicDir = options.adminConsolePublicDir ?? defaultAdminConsolePublicDir;
    this.trustPrincipalHeader = options.trustPrincipalHeader === true;
    this.mcpServer = new EngramMcpServer(this.service, { principal: options.principal });
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

  private resolveRequestPrincipal(req: IncomingMessage): string | undefined {
    if (this.trustPrincipalHeader) {
      const headerValue = req.headers["x-engram-principal"];
      const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
    return this.authenticatedPrincipal;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.host)}`);
    const pathname = parsed.pathname;

    if (this.adminConsoleEnabled && await this.handleAdminConsole(req, res, pathname)) {
      return;
    }

    if (!this.isAuthorized(req)) {
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": "Bearer",
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.method === "POST" && pathname === "/mcp") {
      await this.handleMcpRequest(req, res);
      return;
    }

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
        topK: typeof body.topK === "number" ? body.topK : undefined,
        mode: typeof body.mode === "string" ? body.mode as RecallPlanMode | "auto" : undefined,
        includeDebug: body.includeDebug === true,
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/recall/explain") {
      const body = await this.readJsonBody(req);
      const response = await this.service.recallExplain({
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/observe") {
      const body = await this.readJsonBody(req);
      this.ensureWriteRateLimitAvailable();
      const response = await this.service.observe({
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : "",
        messages: Array.isArray(body.messages) ? body.messages : [],
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        skipExtraction: body.skipExtraction === true,
      });
      this.recordWriteRateLimitHit();
      this.respondJson(res, 202, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/lcm/search") {
      const body = await this.readJsonBody(req);
      const response = await this.service.lcmSearch({
        query: typeof body.query === "string" ? body.query : "",
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        limit: typeof body.limit === "number" ? body.limit : undefined,
      });
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/lcm/status") {
      this.respondJson(res, 200, await this.service.lcmStatus());
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/memories") {
      const body = await this.readJsonBody(req);
      const request = {
        schemaVersion: typeof body.schemaVersion === "number" ? body.schemaVersion : undefined,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
        dryRun: body.dryRun === true,
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        content: typeof body.content === "string" ? body.content : "",
        category: typeof body.category === "string" ? body.category : undefined,
        confidence: typeof body.confidence === "number" ? body.confidence : undefined,
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
        entityRef: typeof body.entityRef === "string" ? body.entityRef : undefined,
        ttl: typeof body.ttl === "string" ? body.ttl : undefined,
        sourceReason: typeof body.sourceReason === "string" ? body.sourceReason : undefined,
      };
      const idempotencyStatus = await this.service.peekMemoryStoreIdempotency(request);
      if (idempotencyStatus === "miss" && request.dryRun !== true) {
        this.ensureWriteRateLimitAvailable();
      }
      const response = await this.service.memoryStore(request);
      if (this.shouldCountWriteRateLimit(response as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, this.writeResponseStatus(response), response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/suggestions") {
      const body = await this.readJsonBody(req);
      const request = {
        schemaVersion: typeof body.schemaVersion === "number" ? body.schemaVersion : undefined,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
        dryRun: body.dryRun === true,
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
        content: typeof body.content === "string" ? body.content : "",
        category: typeof body.category === "string" ? body.category : undefined,
        confidence: typeof body.confidence === "number" ? body.confidence : undefined,
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
        entityRef: typeof body.entityRef === "string" ? body.entityRef : undefined,
        ttl: typeof body.ttl === "string" ? body.ttl : undefined,
        sourceReason: typeof body.sourceReason === "string" ? body.sourceReason : undefined,
      };
      const idempotencyStatus = await this.service.peekSuggestionSubmitIdempotency(request);
      if (idempotencyStatus === "miss" && request.dryRun !== true) {
        this.ensureWriteRateLimitAvailable();
      }
      const response = await this.service.suggestionSubmit(request);
      if (this.shouldCountWriteRateLimit(response as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, this.writeResponseStatus(response), response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/memories") {
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "50", 10);
      const offsetRaw = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      const sortParam = parsed.searchParams.get("sort") ?? undefined;
      const sort = sortParam === "updated_desc"
        || sortParam === "updated_asc"
        || sortParam === "created_desc"
        || sortParam === "created_asc"
        ? sortParam
        : undefined;
      const response = await this.service.memoryBrowse({
        query: parsed.searchParams.get("q") ?? undefined,
        status: parsed.searchParams.get("status") ?? undefined,
        category: parsed.searchParams.get("category") ?? undefined,
        namespace: parsed.searchParams.get("namespace") ?? undefined,
        sort,
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
      });
      this.respondJson(res, 200, response);
      return;
    }

    const memoryMatch = pathname.match(/^\/engram\/v1\/memories\/([^/]+)$/);
    if (req.method === "GET" && memoryMatch) {
      const memoryId = decodeURIComponent(memoryMatch[1] ?? "");
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const response = await this.service.memoryGet(memoryId, namespace, this.resolveRequestPrincipal(req));
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    const timelineMatch = pathname.match(/^\/engram\/v1\/memories\/([^/]+)\/timeline$/);
    if (req.method === "GET" && timelineMatch) {
      const memoryId = decodeURIComponent(timelineMatch[1] ?? "");
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "200", 10);
      const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
      const response = await this.service.memoryTimeline(memoryId, namespace, limit, this.resolveRequestPrincipal(req));
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/entities") {
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "50", 10);
      const offsetRaw = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      const response = await this.service.entityList({
        namespace: parsed.searchParams.get("namespace") ?? undefined,
        query: parsed.searchParams.get("q") ?? undefined,
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
      });
      this.respondJson(res, 200, response);
      return;
    }

    const entityMatch = pathname.match(/^\/engram\/v1\/entities\/([^/]+)$/);
    if (req.method === "GET" && entityMatch) {
      const entityName = decodeURIComponent(entityMatch[1] ?? "");
      const namespace = parsed.searchParams.get("namespace") ?? undefined;
      const response = await this.service.entityGet(entityName, namespace);
      this.respondJson(res, response.found ? 200 : 404, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/review-queue") {
      const response = await this.service.reviewQueue(
        parsed.searchParams.get("runId") ?? undefined,
        parsed.searchParams.get("namespace") ?? undefined,
        this.resolveRequestPrincipal(req),
      );
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/maintenance") {
      this.respondJson(res, 200, await this.service.maintenance(parsed.searchParams.get("namespace") ?? undefined, this.resolveRequestPrincipal(req)));
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/quality") {
      this.respondJson(res, 200, await this.service.quality(parsed.searchParams.get("namespace") ?? undefined, this.resolveRequestPrincipal(req)));
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/trust-zones/status") {
      this.respondJson(
        res,
        200,
        await this.service.trustZoneStatus(parsed.searchParams.get("namespace") ?? undefined, this.resolveRequestPrincipal(req)),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/engram/v1/trust-zones/records") {
      const limitRaw = parseInt(parsed.searchParams.get("limit") ?? "25", 10);
      const offsetRaw = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      const response = await this.service.trustZoneBrowse({
        query: parsed.searchParams.get("q") ?? undefined,
        zone: parseTrustZoneFilter(parsed.searchParams.get("zone")),
        kind: parseTrustZoneKindFilter(parsed.searchParams.get("kind")),
        sourceClass: parseTrustZoneSourceClassFilter(parsed.searchParams.get("sourceClass")),
        namespace: parsed.searchParams.get("namespace") ?? undefined,
        limit: Number.isFinite(limitRaw) ? limitRaw : 25,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
      }, this.resolveRequestPrincipal(req));
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/review-disposition") {
      const body = await this.readJsonBody(req);
      const status = typeof body.status === "string" ? body.status : "";
      if (
        status !== "active" &&
        status !== "pending_review" &&
        status !== "quarantined" &&
        status !== "rejected" &&
        status !== "superseded" &&
        status !== "archived"
      ) {
        throw new HttpError(400, "invalid_review_status");
      }
      this.ensureWriteRateLimitAvailable();
      const response = await this.service.reviewDisposition({
        memoryId: typeof body.memoryId === "string" ? body.memoryId : "",
        status,
        reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : "",
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(response as unknown as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/trust-zones/promote") {
      const body = await this.readJsonBody(req);
      const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
      const targetZone = typeof body.targetZone === "string" ? body.targetZone.trim() : "";
      const promotionReason = typeof body.promotionReason === "string" ? body.promotionReason.trim() : "";
      const dryRun = body.dryRun === true;
      if (!recordId) {
        throw new HttpError(400, "recordId is required");
      }
      if (!isTrustZoneName(targetZone)) {
        throw new HttpError(400, "invalid_trust_zone_target");
      }
      if (!promotionReason) {
        throw new HttpError(400, "promotionReason is required");
      }
      if (!dryRun) {
        this.ensureWriteRateLimitAvailable();
      }
      const response = await this.service.trustZonePromote({
        recordId,
        targetZone,
        promotionReason,
        recordedAt: typeof body.recordedAt === "string" ? body.recordedAt : undefined,
        summary: typeof body.summary === "string" ? body.summary : undefined,
        dryRun,
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(response as unknown as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, response.dryRun ? 200 : 201, response);
      return;
    }

    if (req.method === "POST" && pathname === "/engram/v1/trust-zones/demo-seed") {
      const body = await this.readJsonBody(req);
      const dryRun = body.dryRun === true;
      if (!dryRun) {
        this.ensureWriteRateLimitAvailable();
      }
      const response = await this.service.trustZoneDemoSeed({
        scenario: typeof body.scenario === "string" ? body.scenario : undefined,
        recordedAt: typeof body.recordedAt === "string" ? body.recordedAt : undefined,
        dryRun,
        namespace: typeof body.namespace === "string" ? body.namespace : undefined,
        authenticatedPrincipal: this.resolveRequestPrincipal(req),
      });
      if (this.shouldCountWriteRateLimit(response as unknown as { dryRun?: boolean; idempotencyReplay?: boolean })) {
        this.recordWriteRateLimitHit();
      }
      this.respondJson(res, response.dryRun ? 200 : 201, response);
      return;
    }

    this.respondJson(res, 404, { error: "not_found" });
  }

  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    const request = body as {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };

    // Enforce write rate limiting for MCP tool calls that mutate state,
    // matching the same protection applied to the REST write endpoints.
    // Pre-check ensures capacity; post-check skips counting dry runs and
    // idempotency replays, consistent with the REST handlers.
    const isMcpWrite =
      request.method === "tools/call" &&
      typeof request.params?.name === "string" &&
      (request.params.name === "engram.memory_store" || request.params.name === "engram.suggestion_submit" || request.params.name === "engram.observe");
    if (isMcpWrite) {
      this.ensureWriteRateLimitAvailable();
    }

    const response = await this.mcpServer.handleRequest(request, {
      principalOverride: this.resolveRequestPrincipal(req),
    });

    if (isMcpWrite && response !== null) {
      const result = (response as Record<string, unknown>).result as Record<string, unknown> | undefined;
      const isError = result?.isError === true;
      const structured = result?.structuredContent as { dryRun?: boolean; idempotencyReplay?: boolean } | undefined;
      if (!isError && structured && this.shouldCountWriteRateLimit(structured)) {
        this.recordWriteRateLimitHit();
      }
    }
    if (response === null) {
      res.statusCode = 202;
      res.end();
      return;
    }
    this.respondJson(res, 200, response);
  }

  private respondJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", String(Buffer.byteLength(body)));
    res.end(body);
  }

  private async handleAdminConsole(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (req.method !== "GET") return false;
    if (pathname === "/engram/ui" || pathname === "/engram/ui/") {
      await this.respondStatic(res, path.join(this.adminConsolePublicDir, "index.html"), "text/html; charset=utf-8");
      return true;
    }
    if (pathname === "/engram/ui/app.js") {
      await this.respondStatic(res, path.join(this.adminConsolePublicDir, "app.js"), "application/javascript; charset=utf-8");
      return true;
    }
    return false;
  }

  private async respondStatic(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
    try {
      const body = await readFile(filePath, "utf-8");
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("content-length", String(Buffer.byteLength(body)));
      res.end(body);
    } catch {
      this.respondJson(res, 404, { error: "not_found" });
    }
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

  private writeResponseStatus(response: { dryRun: boolean; status: string }): number {
    if (response.dryRun === true) return 200;
    if (response.status === "stored" || response.status === "queued_for_review") return 201;
    return 200;
  }

  private ensureWriteRateLimitAvailable(): void {
    const now = Date.now();
    while (
      this.writeRequestTimestamps.length > 0 &&
      now - (this.writeRequestTimestamps[0] ?? 0) > WRITE_RATE_LIMIT_WINDOW_MS
    ) {
      this.writeRequestTimestamps.shift();
    }
    if (this.writeRequestTimestamps.length >= WRITE_RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpError(429, "write_rate_limited");
    }
  }

  private recordWriteRateLimitHit(): void {
    this.writeRequestTimestamps.push(Date.now());
  }

  private shouldCountWriteRateLimit(response: { dryRun?: boolean; idempotencyReplay?: boolean }): boolean {
    return response.dryRun !== true && response.idempotencyReplay !== true;
  }
}
