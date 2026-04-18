/**
 * OpenAI-compatible HTTP proxy for WeClone with Remnic memory injection.
 *
 * Intercepts POST /v1/chat/completions to inject recalled memories,
 * forwards all other requests transparently to the WeClone API.
 */

import * as http from "node:http";
import type { WeCloneConnectorConfig } from "./config.js";
import { formatMemoryBlock, type RecallResult } from "./format.js";
import {
  SingleSessionMapper,
  CallerIdSessionMapper,
  type SessionMapper,
  type ChatCompletionRequest,
} from "./session.js";

export interface WeCloneProxy {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
}

interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Read the entire body of an IncomingMessage as a string.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Build a flat headers record from IncomingHttpHeaders,
 * normalizing array values to comma-separated strings.
 */
function flattenHeaders(
  raw: http.IncomingHttpHeaders
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) continue;
    result[key] = Array.isArray(val) ? val.join(", ") : val;
  }
  return result;
}

/**
 * Call Remnic daemon recall endpoint for the given session and query.
 */
async function recallMemories(
  daemonUrl: string,
  sessionKey: string,
  query: string
): Promise<RecallResult[]> {
  const url = `${daemonUrl}/engram/v1/recall`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, query }),
  });

  if (!res.ok) {
    throw new Error(`Remnic recall returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { results?: RecallResult[] };
  return data.results ?? [];
}

/**
 * Fire-and-forget observation to the Remnic daemon.
 * Errors are caught and silently discarded to avoid adding latency.
 */
function observeTurn(
  daemonUrl: string,
  sessionKey: string,
  userMessage: string,
  assistantMessage: string
): void {
  const url = `${daemonUrl}/engram/v1/observe`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, userMessage, assistantMessage }),
  }).catch(() => {
    // Intentionally swallowed -- observation must not affect the response path
  });
}

/**
 * Extract the last user message from a chat completion messages array.
 */
function lastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i].content;
    }
  }
  return "";
}

/**
 * Extract the assistant reply from a WeClone chat completion response.
 */
function extractAssistantReply(responseBody: Record<string, unknown>): string {
  const choices = responseBody.choices as
    | Array<{ message?: { content?: string } }>
    | undefined;
  if (choices && choices.length > 0) {
    return choices[0]?.message?.content ?? "";
  }
  return "";
}

/**
 * Inject memories into the messages array by modifying the system message.
 */
function injectMemories(
  messages: ChatMessage[],
  memoryBlock: string,
  position: "system-append" | "system-prepend"
): ChatMessage[] {
  if (memoryBlock.length === 0) return messages;

  const result = messages.map((m) => ({ ...m }));
  const systemIdx = result.findIndex((m) => m.role === "system");

  if (systemIdx >= 0) {
    const existing = result[systemIdx].content;
    result[systemIdx].content =
      position === "system-prepend"
        ? `${memoryBlock}\n\n${existing}`
        : `${existing}\n\n${memoryBlock}`;
  } else {
    // No system message exists -- prepend one
    result.unshift({ role: "system", content: memoryBlock });
  }

  return result;
}

/**
 * Derive the origin (scheme + host + port) from a URL string.
 * e.g. "http://localhost:8000/v1" -> "http://localhost:8000"
 */
function getOrigin(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.origin;
  } catch {
    // Fallback: strip trailing path components
    const match = urlStr.match(/^(https?:\/\/[^/]+)/);
    return match ? match[1] : urlStr;
  }
}

/**
 * Forward a request transparently to the WeClone API.
 * Uses the origin of wecloneApiUrl so that incoming paths
 * (e.g. /v1/models) map 1:1 to upstream paths.
 */
async function transparentProxy(
  wecloneApiUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | null,
  res: http.ServerResponse
): Promise<void> {
  const origin = getOrigin(wecloneApiUrl);
  const targetUrl = `${origin}${path}`;

  // Remove hop-by-hop headers
  const forwardHeaders = { ...headers };
  delete forwardHeaders["host"];
  delete forwardHeaders["connection"];

  const fetchInit: RequestInit = {
    method,
    headers: forwardHeaders,
  };
  if (body && method !== "GET" && method !== "HEAD") {
    fetchInit.body = body;
  }

  try {
    const upstream = await fetch(targetUrl, fetchInit);
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
    const responseBody = await upstream.arrayBuffer();
    res.end(Buffer.from(responseBody));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_unreachable", detail: String(err) }));
  }
}

/**
 * Create a WeClone proxy instance.
 */
export function createWeCloneProxy(config: WeCloneConnectorConfig): WeCloneProxy {
  const sessionMapper: SessionMapper =
    config.sessionStrategy === "caller-id"
      ? new CallerIdSessionMapper()
      : new SingleSessionMapper();

  let server: http.Server | null = null;
  let resolvedPort = config.proxyPort;

  const requestHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    // --- Health check ---
    if (url === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        wecloneApi: config.wecloneApiUrl,
      }));
      return;
    }

    // --- Chat completions with memory injection ---
    if (url === "/v1/chat/completions" && method === "POST") {
      let bodyStr: string;
      try {
        bodyStr = await readBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request", detail: "Could not read request body" }));
        return;
      }

      let parsed: ChatCompletionRequest;
      try {
        parsed = JSON.parse(bodyStr) as ChatCompletionRequest;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request", detail: "Invalid JSON body" }));
        return;
      }

      const headers = req.headers as Record<string, string | string[] | undefined>;
      const sessionKey = sessionMapper.resolve(headers, parsed);
      const messages = (parsed.messages ?? []) as ChatMessage[];
      const query = lastUserMessage(messages);

      // Recall memories (graceful degradation on failure)
      let memoryBlock = "";
      if (query.length > 0) {
        try {
          const memories = await recallMemories(
            config.remnicDaemonUrl,
            sessionKey,
            query
          );
          memoryBlock = formatMemoryBlock(
            memories,
            config.memoryInjection.template,
            config.memoryInjection.maxTokens
          );
        } catch {
          // Remnic recall failed -- proceed without memory injection
        }
      }

      // Inject memories into messages
      const modifiedMessages = injectMemories(
        messages,
        memoryBlock,
        config.memoryInjection.position
      );

      const modifiedBody = {
        ...parsed,
        messages: modifiedMessages,
      };

      // Forward to WeClone
      const targetUrl = `${config.wecloneApiUrl}/chat/completions`;
      const forwardHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Preserve authorization if present
      const authHeader = req.headers["authorization"];
      if (typeof authHeader === "string") {
        forwardHeaders["Authorization"] = authHeader;
      }

      try {
        const upstream = await fetch(targetUrl, {
          method: "POST",
          headers: forwardHeaders,
          body: JSON.stringify(modifiedBody),
        });

        const responseBuffer = await upstream.arrayBuffer();
        const responseBytes = Buffer.from(responseBuffer);

        // Parse response for observation (best-effort)
        let assistantReply = "";
        try {
          const responseJson = JSON.parse(
            responseBytes.toString("utf-8")
          ) as Record<string, unknown>;
          assistantReply = extractAssistantReply(responseJson);
        } catch {
          // Non-JSON response -- skip observation
        }

        // Fire-and-forget observe
        if (query.length > 0 && assistantReply.length > 0) {
          observeTurn(config.remnicDaemonUrl, sessionKey, query, assistantReply);
        }

        // Return upstream response to caller
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
        res.end(responseBytes);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "upstream_unreachable",
          detail: String(err),
        }));
      }
      return;
    }

    // --- All other paths: transparent proxy ---
    const body = method !== "GET" && method !== "HEAD" ? await readBody(req) : null;
    const flat = flattenHeaders(req.headers);
    await transparentProxy(config.wecloneApiUrl, method, url, flat, body, res);
  };

  return {
    get port() {
      return resolvedPort;
    },

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          requestHandler(req, res).catch((err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "internal", detail: String(err) }));
            }
          });
        });

        server.on("error", reject);

        server.listen(config.proxyPort, () => {
          const addr = server!.address();
          if (typeof addr === "object" && addr !== null) {
            resolvedPort = addr.port;
          }
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => {
          server = null;
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
