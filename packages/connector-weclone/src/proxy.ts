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
 * Read the entire body of an IncomingMessage as a string (UTF-8).
 * Used for paths that need to parse JSON (e.g. chat completions).
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
 * Read the entire body of an IncomingMessage as raw bytes.
 * Used for the transparent proxy path to avoid corrupting binary/multipart uploads.
 */
function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
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
 * Build standard headers for Remnic daemon requests.
 * Includes Authorization if an auth token is configured.
 */
function remnicHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}

/**
 * Call Remnic daemon recall endpoint for the given session and query.
 */
async function recallMemories(
  daemonUrl: string,
  sessionKey: string,
  query: string,
  authToken?: string
): Promise<RecallResult[]> {
  const url = `${daemonUrl}/engram/v1/recall`;
  const res = await fetch(url, {
    method: "POST",
    headers: remnicHeaders(authToken),
    body: JSON.stringify({ sessionKey, query }),
  });

  if (!res.ok) {
    throw new Error(`Remnic recall returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { results?: Array<{ preview?: string; content?: string; confidence?: number; category?: string }> };
  const memories: RecallResult[] = (data.results ?? []).map((r) => ({
    content: r.preview || r.content || "",
    confidence: r.confidence,
    category: r.category,
  }));
  return memories;
}

/**
 * Fire-and-forget observation to the Remnic daemon.
 * Errors are caught and silently discarded to avoid adding latency.
 */
function observeTurn(
  daemonUrl: string,
  sessionKey: string,
  userMessage: string,
  assistantMessage: string,
  authToken?: string
): void {
  const url = `${daemonUrl}/engram/v1/observe`;
  fetch(url, {
    method: "POST",
    headers: remnicHeaders(authToken),
    body: JSON.stringify({
      sessionKey,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: assistantMessage },
      ],
    }),
  }).catch(() => {
    // Intentionally swallowed -- observation must not affect the response path
  });
}

/**
 * Coerce an OpenAI chat message `content` into a plain text string.
 *
 * OpenAI chat messages can be either a string or an array of content
 * parts (e.g. `[{type:"text",text:"..."},{type:"image_url",...}]`) for
 * multimodal inputs. Recall/observe only operate on text, so we extract
 * and concatenate the `text` parts. Returns an empty string if no text
 * is present (e.g. image-only turn) so we skip recall rather than sending
 * non-string payloads to the Remnic daemon.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
    ) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/**
 * Extract the last user message's text content from a chat completion
 * messages array. Handles both string and multimodal array content.
 */
function lastUserMessage(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return extractTextContent(messages[i].content);
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
 * Strip trailing slashes from a URL without using a regex quantifier
 * on the same character, which CodeQL flags as polynomial ReDoS
 * (`js/polynomial-redos`). A simple loop is O(n) and cannot backtrack.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

/**
 * Parse a URL string into { origin, basePath } where `basePath` is the
 * configured path prefix (e.g. "/weclone/v1") with any trailing slashes
 * stripped. Falls back safely for malformed inputs.
 */
function splitBaseUrl(urlStr: string): { origin: string; basePath: string } {
  try {
    const parsed = new URL(urlStr);
    const basePath = stripTrailingSlashes(parsed.pathname);
    return { origin: parsed.origin, basePath };
  } catch {
    // Fallback: strip trailing path components without ReDoS-prone regex.
    // Split on the first "/" after the scheme.
    const schemeEnd = urlStr.indexOf("://");
    if (schemeEnd === -1) {
      return { origin: stripTrailingSlashes(urlStr), basePath: "" };
    }
    const afterScheme = urlStr.slice(schemeEnd + 3);
    const pathStart = afterScheme.indexOf("/");
    if (pathStart === -1) {
      return { origin: urlStr, basePath: "" };
    }
    const origin = urlStr.slice(0, schemeEnd + 3 + pathStart);
    const basePath = stripTrailingSlashes(afterScheme.slice(pathStart));
    return { origin, basePath };
  }
}

/**
 * Hop-by-hop request headers that must not be forwarded to upstream.
 * Per RFC 2616 §13.5.1 / RFC 7230 §6.1 these apply only to the
 * immediate transport connection. `proxy-authorization` is the most
 * critical — leaking it would send proxy credentials to the origin.
 *
 * `host` is deliberately excluded from this set because it is
 * always replaced (not just stripped) with the upstream origin
 * and is handled separately below.
 */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers that must not be forwarded from the upstream response.
 * These are hop-by-hop headers that apply to a single transport connection
 * and would conflict with our fully-buffered response write.
 *
 * `content-encoding` is included because fetch() auto-decompresses the body.
 * When we buffer with arrayBuffer() and relay, the bytes are already decoded;
 * forwarding `content-encoding: gzip` would label decompressed bytes as gzip.
 */
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "transfer-encoding",
  "content-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

/**
 * Forward a request transparently to the WeClone API.
 *
 * If the configured WeClone URL has a non-empty base path (e.g.
 * "https://host/weclone/v1"), the proxy forwards incoming request paths
 * such that "/v1/models" maps to "https://host/weclone/v1/models". For
 * URLs without a base path, paths map 1:1 to the upstream origin.
 *
 * The request body (if any) is forwarded as raw bytes via Uint8Array so
 * that multipart/binary uploads are not corrupted.
 *
 * Reads the full upstream response before writing to the client
 * to avoid partial-header or hanging-body issues.
 */
async function transparentProxy(
  weclone: { origin: string; basePath: string },
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | null,
  res: http.ServerResponse
): Promise<void> {
  // Map the client-facing path into an upstream path.
  //
  // The proxy exposes an OpenAI-compatible `/v1/...` surface. When the
  // configured `wecloneApiUrl` itself already ends in `/v1` (or any
  // path prefix), treat the configured prefix as the upstream mount
  // point and rewrite `/v1/<rest>` to `<basePath>/<rest>`.
  //
  // - basePath "" (no prefix): forward path as-is.
  // - basePath "/v1": "/v1/models" -> "/v1/models" (no change).
  // - basePath "/weclone/v1": "/v1/models" -> "/weclone/v1/models".
  //
  // Split off any query string so rewriting operates on the pathname only.
  const qIdx = path.indexOf("?");
  const rawPath = qIdx === -1 ? path : path.slice(0, qIdx);
  const querySuffix = qIdx === -1 ? "" : path.slice(qIdx);
  let upstreamPathname = rawPath;
  if (weclone.basePath.length > 0) {
    if (rawPath === "/v1" || rawPath.startsWith("/v1/")) {
      upstreamPathname = `${weclone.basePath}${rawPath.slice(3)}`;
    } else if (!rawPath.startsWith(weclone.basePath)) {
      upstreamPathname = `${weclone.basePath}${rawPath}`;
    }
  }
  const targetUrl = `${weclone.origin}${upstreamPathname}${querySuffix}`;

  // Remove hop-by-hop request headers and replace host with upstream origin
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === "host" || HOP_BY_HOP_REQUEST_HEADERS.has(key)) continue;
    // content-length is recomputed by fetch() for the forwarded body
    if (key === "content-length") continue;
    forwardHeaders[key] = value;
  }

  const fetchInit: RequestInit = {
    method,
    headers: forwardHeaders,
  };
  if (body && method !== "GET" && method !== "HEAD") {
    // Use Uint8Array (a valid BodyInit) instead of Buffer to satisfy
    // RequestInit typing and forward raw bytes verbatim.
    fetchInit.body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  try {
    const upstream = await fetch(targetUrl, fetchInit);

    // Read full body before sending any headers to the client
    const responseBody = await upstream.arrayBuffer();
    const responseBuffer = Buffer.from(responseBody);

    // Build response headers, filtering hop-by-hop and setting Content-Length
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of upstream.headers.entries()) {
      if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }
    responseHeaders["content-length"] = String(responseBuffer.length);

    res.writeHead(upstream.status, responseHeaders);
    res.end(responseBuffer);
  } catch (_err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_unreachable" }));
  }
}

/**
 * Create a WeClone proxy instance.
 */
export function createWeCloneProxy(config: WeCloneConnectorConfig): WeCloneProxy {
  // Normalize upstream URLs: strip trailing slashes to prevent double-slash
  // when appending path segments. Use a loop (not regex) to avoid the
  // polynomial-ReDoS class flagged by CodeQL for `/\/+$/`.
  const wecloneApiUrl = stripTrailingSlashes(config.wecloneApiUrl);
  const remnicDaemonUrl = stripTrailingSlashes(config.remnicDaemonUrl);
  // Pre-split the WeClone URL so transparentProxy and the chat path can
  // honor a configured base path (e.g. "/weclone/v1").
  const wecloneParts = splitBaseUrl(wecloneApiUrl);

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

    // Parse the request URL into a pathname (stripping query string and
    // normalizing trailing slash). Using pathname for route matching avoids
    // silently falling through when clients append query params like
    // `?api-version=2023-05-15` (common with Azure OpenAI-compatible SDKs).
    let pathname = url;
    const queryStart = url.indexOf("?");
    if (queryStart !== -1) pathname = url.slice(0, queryStart);
    // Normalize trailing slash for route matching only (not for forwarding).
    const normalizedPathname =
      pathname.length > 1 && pathname.endsWith("/")
        ? pathname.slice(0, -1)
        : pathname;

    // --- Health check ---
    if (normalizedPathname === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        wecloneApi: config.wecloneApiUrl,
      }));
      return;
    }

    // --- Chat completions with memory injection ---
    if (normalizedPathname === "/v1/chat/completions" && method === "POST") {
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
      // Messages may contain multimodal content-parts arrays; keep them
      // untyped and validate strings at each use site.
      const rawMessages = (parsed.messages ?? []) as Array<{
        role: string;
        content: unknown;
      }>;
      const query = lastUserMessage(rawMessages);

      // Recall memories (graceful degradation on failure)
      let memoryBlock = "";
      if (query.length > 0) {
        try {
          const memories = await recallMemories(
            remnicDaemonUrl,
            sessionKey,
            query,
            config.remnicAuthToken
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

      // Build a string-content view for memory injection only. The
      // forwarded payload preserves the original message shapes so
      // multimodal parts are not flattened on the way to WeClone.
      const stringMessages: ChatMessage[] = rawMessages.map((m) => ({
        role: m.role,
        content: extractTextContent(m.content),
      }));
      const modifiedStringMessages = injectMemories(
        stringMessages,
        memoryBlock,
        config.memoryInjection.position
      );

      // Merge: keep original (possibly multimodal) messages, but use the
      // modified system prompt text from the injection step.
      const outMessages: Array<{ role: string; content: unknown }> = [];
      // If injection added a leading synthetic system message (no original
      // system existed), surface it as a string-content message.
      const hadSystem = rawMessages.some((m) => m.role === "system");
      if (!hadSystem && modifiedStringMessages[0]?.role === "system") {
        outMessages.push({
          role: "system",
          content: modifiedStringMessages[0].content,
        });
      }
      for (const m of rawMessages) {
        if (m.role === "system") {
          const updated = modifiedStringMessages.find((s) => s.role === "system");
          outMessages.push({
            role: "system",
            content: updated ? updated.content : extractTextContent(m.content),
          });
        } else {
          outMessages.push(m);
        }
      }

      const modifiedBody = {
        ...parsed,
        messages: outMessages,
      };

      // Forward to WeClone. If `wecloneApiUrl` has a path prefix (the
      // common `/v1` or custom mounts like `/weclone/v1`), forward to
      // `${basePath}/chat/completions`. If the configured URL has no
      // base path at all, default to the standard OpenAI `/v1/chat/completions`.
      const chatBase = wecloneParts.basePath.length > 0
        ? wecloneParts.basePath
        : "/v1";
      const targetUrl = `${wecloneParts.origin}${chatBase}/chat/completions`;
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

        // --- Streaming path ---
        if (parsed.stream === true) {
          // If upstream returned an error, pass through as-is (don't force SSE headers)
          if (!upstream.ok) {
            const errBody = await upstream.arrayBuffer();
            res.writeHead(upstream.status, {
              "content-type": upstream.headers.get("content-type") || "application/json",
            });
            res.end(Buffer.from(errBody));
            return;
          }

          res.writeHead(upstream.status, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          const reader = upstream.body?.getReader();
          if (!reader) {
            res.end();
            return;
          }

          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              res.write(value);
            }
          } finally {
            res.end();
          }

          // Best-effort: reconstruct assistant content for observation
          try {
            const fullText = Buffer.concat(chunks).toString("utf-8");
            const contentParts: string[] = [];
            for (const line of fullText.split("\n")) {
              if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
              try {
                const event = JSON.parse(line.slice(6)) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                };
                const delta = event.choices?.[0]?.delta?.content;
                if (delta) contentParts.push(delta);
              } catch {
                // Malformed SSE chunk -- skip
              }
            }
            if (contentParts.length > 0 && query.length > 0) {
              observeTurn(
                remnicDaemonUrl,
                sessionKey,
                query,
                contentParts.join(""),
                config.remnicAuthToken
              );
            }
          } catch {
            // Observation reconstruction failed -- non-critical
          }
          return;
        }

        // --- Non-streaming path ---
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
          observeTurn(remnicDaemonUrl, sessionKey, query, assistantReply, config.remnicAuthToken);
        }

        // Return upstream response to caller, stripping hop-by-hop headers
        const chatResponseHeaders: Record<string, string> = {};
        for (const [key, value] of upstream.headers.entries()) {
          if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
            chatResponseHeaders[key] = value;
          }
        }
        chatResponseHeaders["content-length"] = String(responseBytes.length);
        res.writeHead(upstream.status, chatResponseHeaders);
        res.end(responseBytes);
      } catch (_err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "upstream_unreachable",
        }));
      }
      return;
    }

    // --- All other paths: transparent proxy ---
    // Use raw bytes to avoid corrupting binary/multipart uploads.
    const body = method !== "GET" && method !== "HEAD" ? await readRawBody(req) : null;
    const flat = flattenHeaders(req.headers);
    await transparentProxy(wecloneParts, method, url, flat, body, res);
  };

  return {
    get port() {
      return resolvedPort;
    },

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          requestHandler(req, res).catch((_err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "internal_proxy_error" }));
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
