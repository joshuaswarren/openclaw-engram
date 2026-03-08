import type { Readable, Writable } from "node:stream";
import type { EngramAccessService } from "./access-service.js";

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

export class EngramMcpServer {
  private buffer = Buffer.alloc(0);
  private readonly tools: McpTool[];

  constructor(private readonly service: EngramAccessService) {
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
          },
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
            version: "9.0.0",
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
      void this.flushBuffer(output);
    });
    await new Promise<void>((resolve, reject) => {
      input.on("end", resolve);
      input.on("error", reject);
    });
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

      const parsed = JSON.parse(body) as JsonRpcRequest;
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
        });
      case "engram.recall_explain":
        return this.service.recallExplain({
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
        });
      case "engram.memory_get":
        return this.service.memoryGet(
          typeof args.memoryId === "string" ? args.memoryId : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.memory_timeline": {
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 200;
        return this.service.memoryTimeline(
          typeof args.memoryId === "string" ? args.memoryId : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
          limit,
        );
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
