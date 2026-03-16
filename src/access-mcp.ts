import type { Readable, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import type { EngramAccessService } from "./access-service.js";
import type { RecallPlanMode } from "./types.js";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const MCP_PROTOCOL_VERSION = "2024-11-05";

async function getMcpServerVersion(): Promise<string> {
  const envVersion = process.env.OPENCLAW_ENGRAM_VERSION?.trim() || process.env.npm_package_version?.trim();
  if (envVersion) return envVersion;
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = await readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export class EngramMcpServer {
  private buffer = Buffer.alloc(0);
  private flushTask: Promise<void> | null = null;
  private readonly tools: McpTool[];
  private readonly authenticatedPrincipal?: string;

  constructor(
    private readonly service: EngramAccessService,
    options: { principal?: string } = {},
  ) {
    this.authenticatedPrincipal =
      options.principal?.trim() || process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL?.trim() || undefined;
    this.tools = [
      {
        name: "engram.recall",
        description: "Recall Engram context for a query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            sessionKey: { type: "string" },
            namespace: { type: "string" },
            topK: { type: "number" },
            mode: { type: "string", enum: ["auto", "no_recall", "minimal", "full", "graph_mode"] },
            includeDebug: { type: "boolean" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.recall_explain",
        description: "Return the last recall snapshot for a session or the most recent one.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string" },
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.day_summary",
        description:
          "Generate a structured end-of-day summary. When memories is omitted or empty, auto-gathers today's facts and hourly summaries from storage.",
        inputSchema: {
          type: "object",
          properties: {
            memories: { type: "string" },
            sessionKey: { type: "string" },
            namespace: { type: "string" },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_get",
        description: "Fetch one Engram memory by id.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
          },
          required: ["memoryId"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_timeline",
        description: "Fetch one Engram memory timeline by id.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
            limit: { type: "number" },
          },
          required: ["memoryId"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_store",
        description: "Store an explicit Engram memory through the access layer.",
        inputSchema: {
          type: "object",
          properties: {
            schemaVersion: { type: "number" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean" },
            sessionKey: { type: "string" },
            content: { type: "string" },
            category: { type: "string" },
            confidence: { type: "number" },
            namespace: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            entityRef: { type: "string" },
            ttl: { type: "string" },
            sourceReason: { type: "string" },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.suggestion_submit",
        description: "Queue a suggested Engram memory for review.",
        inputSchema: {
          type: "object",
          properties: {
            schemaVersion: { type: "number" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean" },
            sessionKey: { type: "string" },
            content: { type: "string" },
            category: { type: "string" },
            confidence: { type: "number" },
            namespace: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            entityRef: { type: "string" },
            ttl: { type: "string" },
            sourceReason: { type: "string" },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.entity_get",
        description: "Fetch one Engram entity by name.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            namespace: { type: "string" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.review_queue_list",
        description: "Fetch the latest Engram review queue artifact bundle.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.observe",
        description: "Feed conversation messages into Engram's memory pipeline (LCM archive + extraction).",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Conversation session identifier" },
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
                required: ["role", "content"],
              },
              description: "Conversation messages to observe",
            },
            namespace: { type: "string" },
            skipExtraction: { type: "boolean" },
          },
          required: ["sessionKey", "messages"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.lcm_search",
        description: "Search the LCM conversation archive for matching content.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            sessionKey: { type: "string", description: "Optional session filter" },
            namespace: { type: "string" },
            limit: { type: "number", description: "Max results to return" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleRequest(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const id = request.id ?? null;
    const method = request.method ?? "";

    if (method === "notifications/initialized") return null;
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "initialize") {
      const version = await getMcpServerVersion();
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "openclaw-engram",
            version,
          },
        },
      };
    }
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.tools,
        },
      };
    }
    if (method === "tools/call") {
      const params = request.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const argumentsObject =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      try {
        const result = await this.callTool(name, argumentsObject);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    };
  }

  async runStdio(input: Readable, output: Writable): Promise<void> {
    input.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      this.scheduleFlush(output);
    });
    await new Promise<void>((resolve, reject) => {
      input.on("end", resolve);
      input.on("error", reject);
    });
    while (this.flushTask) {
      await this.flushTask;
    }
  }

  private scheduleFlush(output: Writable): void {
    if (this.flushTask) return;
    const task = this.flushBuffer(output)
      .catch((err) => {
        this.writeMessage(output, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      })
      .finally(() => {
        if (this.flushTask === task) {
          this.flushTask = null;
        }
        if (this.buffer.length > 0) {
          this.scheduleFlush(output);
        }
      });
    this.flushTask = task;
  }

  private async flushBuffer(output: Writable): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.buffer.slice(0, headerEnd).toString("utf-8");
      const headers = headerText.split("\r\n");
      const contentLengthHeader = headers.find((line) => line.toLowerCase().startsWith("content-length:"));
      if (!contentLengthHeader) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const contentLength = parseInt(contentLengthHeader.split(":")[1]?.trim() ?? "0", 10);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.slice(messageStart, messageEnd).toString("utf-8");
      this.buffer = this.buffer.slice(messageEnd);

      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(body) as JsonRpcRequest;
      } catch {
        this.writeMessage(output, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
          },
        });
        continue;
      }
      const response = await this.handleRequest(parsed);
      if (response) {
        this.writeMessage(output, response);
      }
    }
  }

  private writeMessage(output: Writable, payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    const message = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
    output.write(message);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "engram.recall":
        return this.service.recall({
          query: typeof args.query === "string" ? args.query : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          topK: typeof args.topK === "number" && Number.isFinite(args.topK) ? args.topK : undefined,
          mode: typeof args.mode === "string" ? args.mode as RecallPlanMode | "auto" : undefined,
          includeDebug: args.includeDebug === true,
        });
      case "engram.recall_explain":
        return this.service.recallExplain({
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
      case "engram.day_summary":
        return this.service.daySummary({
          memories: typeof args.memories === "string" ? args.memories : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
      case "engram.memory_get":
        return this.service.memoryGet(
          typeof args.memoryId === "string" ? args.memoryId : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
          this.authenticatedPrincipal,
        );
      case "engram.memory_timeline": {
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 200;
        return this.service.memoryTimeline(
          typeof args.memoryId === "string" ? args.memoryId : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
          limit,
          this.authenticatedPrincipal,
        );
      }
      case "engram.memory_store":
        return this.service.memoryStore({
          schemaVersion: typeof args.schemaVersion === "number" ? args.schemaVersion : undefined,
          idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
          dryRun: args.dryRun === true,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          authenticatedPrincipal: this.authenticatedPrincipal,
          content: typeof args.content === "string" ? args.content : "",
          category: typeof args.category === "string" ? args.category : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
          entityRef: typeof args.entityRef === "string" ? args.entityRef : undefined,
          ttl: typeof args.ttl === "string" ? args.ttl : undefined,
          sourceReason: typeof args.sourceReason === "string" ? args.sourceReason : undefined,
        });
      case "engram.suggestion_submit":
        return this.service.suggestionSubmit({
          schemaVersion: typeof args.schemaVersion === "number" ? args.schemaVersion : undefined,
          idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
          dryRun: args.dryRun === true,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          authenticatedPrincipal: this.authenticatedPrincipal,
          content: typeof args.content === "string" ? args.content : "",
          category: typeof args.category === "string" ? args.category : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
          entityRef: typeof args.entityRef === "string" ? args.entityRef : undefined,
          ttl: typeof args.ttl === "string" ? args.ttl : undefined,
          sourceReason: typeof args.sourceReason === "string" ? args.sourceReason : undefined,
        });
      case "engram.entity_get":
        return this.service.entityGet(
          typeof args.name === "string" ? args.name : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.review_queue_list":
        return this.service.reviewQueue(
          typeof args.runId === "string" ? args.runId : undefined,
          typeof args.namespace === "string" ? args.namespace : undefined,
          this.authenticatedPrincipal,
        );
      case "engram.observe":
        return this.service.observe({
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : "",
          messages: Array.isArray(args.messages) ? args.messages : [],
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          authenticatedPrincipal: this.authenticatedPrincipal,
          skipExtraction: args.skipExtraction === true,
        });
      case "engram.lcm_search":
        return this.service.lcmSearch({
          query: typeof args.query === "string" ? args.query : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          limit: typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined,
        });
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
