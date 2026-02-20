import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.js";
import type { QmdSearchResult } from "./types.js";

const QMD_TIMEOUT_MS = 30_000;
const QMD_DAEMON_TIMEOUT_MS = 60_000; // Longer timeout for daemon (first call may load models)
const QMD_UPDATE_BACKOFF_MS = 15 * 60 * 1000; // 15m
const QMD_EMBED_BACKOFF_MS = 60 * 60 * 1000; // 60m
const QMD_FALLBACK_PATHS = [
  path.join(os.homedir(), ".bun", "bin", "qmd"),
  "/usr/local/bin/qmd",
  "/opt/homebrew/bin/qmd",
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isSqliteBusyError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("database is locked") ||
    lower.includes("sqlite_busy") ||
    lower.includes("sqlite_busy_recovery") ||
    lower.includes("sqliterror: database is locked")
  );
}

function stripControlChars(s: string): string {
  // Remove ANSI escapes and other control characters that explode logs.
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u001f\u007f]/g, "");
}

function truncateForLog(s: string, max = 2000): string {
  const cleaned = stripControlChars(s);
  return cleaned.length > max ? cleaned.slice(0, max) + "…(truncated)" : cleaned;
}

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const QMD_MUTEX = new AsyncMutex();

function runQmd(
  args: string[],
  timeoutMs: number = QMD_TIMEOUT_MS,
  qmdPath: string = "qmd",
): Promise<{ stdout: string; stderr: string }> {
  // Serialize all qmd calls. This avoids SQLite lock contention when multiple
  // channels/agents trigger QMD operations at nearly the same time.
  return QMD_MUTEX.runExclusive(async () => {
    const maxAttempts = isLikelyWriteCommand(args) ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await runQmdOnce(args, timeoutMs, qmdPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts && isSqliteBusyError(msg)) {
          // Another qmd call (or an external qmd process) currently holds the DB.
          // Back off briefly and retry.
          await sleep(1500 * attempt);
          continue;
        }
        throw err;
      }
    }
    // unreachable
    throw new Error("qmd command failed");
  });
}

function isLikelyWriteCommand(args: string[]): boolean {
  const cmd = args[0] ?? "";
  return cmd === "update" || cmd === "embed" || cmd === "cleanup" || cmd === "collection";
}

function runQmdOnce(
  args: string[],
  timeoutMs: number,
  qmdPath: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(qmdPath, args, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`qmd ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // QMD returns exit code 1 for --version (shows usage), but that's ok
      const isVersionCheck = args.length === 1 && args[0] === "--version";
      if (code === 0 || (isVersionCheck && code === 1)) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `qmd ${args.join(" ")} failed (code ${code}): ${truncateForLog(stderr || stdout)}`,
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// QMD HTTP Daemon Session (MCP over HTTP)
// ---------------------------------------------------------------------------

let nextJsonRpcId = 1;

class QmdDaemonSession {
  private sessionId: string | null = null;
  private readonly baseUrl: string;

  constructor(daemonUrl: string) {
    // daemonUrl is the MCP endpoint, e.g. http://localhost:8181/mcp
    // baseUrl is the root, e.g. http://localhost:8181
    this.baseUrl = daemonUrl.replace(/\/mcp\/?$/, "");
  }

  /** Check if the daemon HTTP server is reachable. */
  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Perform MCP handshake: initialize + notifications/initialized. */
  async initialize(): Promise<boolean> {
    try {
      // Step 1: initialize
      const initRes = await this.postMcp({
        jsonrpc: "2.0",
        id: nextJsonRpcId++,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "openclaw-engram", version: "1.0.0" },
        },
      });

      if (!initRes.ok) {
        // "Server already initialized" (HTTP 400) means the daemon is running
        // and already has an active session — treat this as success
        if (initRes.status === 400) {
          const body = await initRes
            .json()
            .catch(() => null) as { error?: { message?: string } } | null;
          if (body?.error?.message?.includes("already initialized")) {
            log.debug("QMD daemon: server already initialized, reusing");
            // Keep or assign a placeholder session ID so isActive() returns true
            if (!this.sessionId) {
              this.sessionId = "reused";
            }
            return true;
          }
        }
        log.debug(`QMD daemon: initialize returned ${initRes.status}`);
        return false;
      }

      // Capture mcp-session-id from response headers
      const sid = initRes.headers.get("mcp-session-id");
      if (sid) {
        this.sessionId = sid;
      }

      // Step 2: notifications/initialized
      await this.postMcp({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      return true;
    } catch (err) {
      log.debug(`QMD daemon: initialize failed: ${err}`);
      return false;
    }
  }

  /** Call an MCP tool and return the parsed result. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number = 30_000,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const id = nextJsonRpcId++;
      const res = await this.postMcp(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        },
        controller.signal,
      );
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`daemon tools/call ${name} returned ${res.status}`);
      }

      const body = await res.json() as {
        error?: unknown;
        result?: unknown;
      };
      if (body.error) {
        throw new Error(`daemon tools/call ${name}: ${JSON.stringify(body.error)}`);
      }
      return body.result;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /** Clear session so the next call triggers re-initialization. */
  invalidate(): void {
    this.sessionId = null;
  }

  isActive(): boolean {
    return this.sessionId !== null;
  }

  private async postMcp(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    return fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }
}

// ---------------------------------------------------------------------------
// QmdClient
// ---------------------------------------------------------------------------

export class QmdClient {
  private available: boolean | null = null;
  private lastUpdateFailAtMs: number | null = null;
  private lastEmbedFailAtMs: number | null = null;
  private readonly updateTimeoutMs: number;
  private readonly slowLog?: { enabled: boolean; thresholdMs: number };
  private readonly configuredQmdPath?: string;
  private qmdPathSource: "auto-path" | "auto-fallback" | "configured" = "auto-path";
  private cliVersion: string | null = null;
  private lastCliProbeError: string | null = null;

  // Daemon mode fields
  private daemonSession: QmdDaemonSession | null = null;
  private daemonAvailable = false;
  private lastDaemonCheckAtMs = 0;
  private readonly daemonRecheckIntervalMs: number;

  constructor(
    private readonly collection: string,
    private readonly maxResults: number,
    opts?: {
      slowLog?: { enabled: boolean; thresholdMs: number };
      updateTimeoutMs?: number;
      qmdPath?: string;
      daemonUrl?: string;
      daemonRecheckIntervalMs?: number;
    },
  ) {
    this.slowLog = opts?.slowLog;
    this.updateTimeoutMs = opts?.updateTimeoutMs ?? 120_000;
    this.configuredQmdPath = opts?.qmdPath?.trim() ? opts.qmdPath.trim() : undefined;
    this.daemonRecheckIntervalMs = opts?.daemonRecheckIntervalMs ?? 60_000;
    if (opts?.daemonUrl) {
      this.daemonSession = new QmdDaemonSession(opts.daemonUrl);
    }
  }

  private qmdPath: string = "qmd";

  async probe(): Promise<boolean> {
    // Try daemon first (if configured)
    if (this.daemonSession) {
      const daemonOk = await this.probeDaemon();
      if (daemonOk) {
        // Still probe CLI for update/embed (subprocess-only operations)
        await this.probeCli();
        return true;
      }
    }

    // Fall back to CLI probe
    return this.probeCli();
  }

  private async probeDaemon(): Promise<boolean> {
    if (!this.daemonSession) return false;
    this.lastDaemonCheckAtMs = Date.now();
    try {
      const healthy = await this.daemonSession.healthCheck();
      if (!healthy) {
        log.debug("QMD daemon: health check failed");
        this.daemonAvailable = false;
        return false;
      }
      const initialized = await this.daemonSession.initialize();
      if (!initialized) {
        log.debug("QMD daemon: MCP initialize failed");
        this.daemonAvailable = false;
        return false;
      }
      log.info("QMD daemon: connected");
      this.daemonAvailable = true;
      return true;
    } catch (err) {
      log.debug(`QMD daemon: probe failed: ${err}`);
      this.daemonAvailable = false;
      return false;
    }
  }

  private async probeCli(): Promise<boolean> {
    const parseVersion = (stdout: string, stderr: string): string | null => {
      const text = `${stdout}\n${stderr}`.trim();
      if (!text) return null;
      return text.split("\n").map((s) => s.trim()).find((s) => s.length > 0) ?? null;
    };
    const markProbeFailure = (err: unknown): void => {
      this.lastCliProbeError = err instanceof Error ? err.message : String(err);
    };

    if (this.configuredQmdPath) {
      try {
        const result = await runQmd(["--version"], 3000, this.configuredQmdPath);
        this.available = true;
        this.qmdPath = this.configuredQmdPath;
        this.qmdPathSource = "configured";
        this.cliVersion = parseVersion(result.stdout, result.stderr);
        this.lastCliProbeError = null;
        return true;
      } catch (err) {
        markProbeFailure(err);
        log.warn(`QMD: configured qmdPath failed (${this.configuredQmdPath}): ${this.lastCliProbeError}`);
        this.available = false;
        return false;
      }
    }

    // Try PATH first
    try {
      const result = await runQmd(["--version"], 3000, "qmd");
      this.available = true;
      this.qmdPath = "qmd";
      this.qmdPathSource = "auto-path";
      this.cliVersion = parseVersion(result.stdout, result.stderr);
      this.lastCliProbeError = null;
      return true;
    } catch (err) {
      markProbeFailure(err);
      // Try fallback paths
      for (const fallbackPath of QMD_FALLBACK_PATHS) {
        try {
          const result = await runQmd(["--version"], 3000, fallbackPath);
          this.available = true;
          this.qmdPath = fallbackPath;
          this.qmdPathSource = "auto-fallback";
          this.cliVersion = parseVersion(result.stdout, result.stderr);
          this.lastCliProbeError = null;
          log.info(`QMD: found at ${fallbackPath}`);
          return true;
        } catch (fallbackErr) {
          markProbeFailure(fallbackErr);
          // Continue to next fallback
        }
      }
      this.available = false;
      return false;
    }
  }

  /** Re-probe daemon if it was down and recheck interval has elapsed. */
  private async maybeProbeDaemon(): Promise<void> {
    if (!this.daemonSession) return;
    if (this.daemonAvailable) return;
    const elapsed = Date.now() - this.lastDaemonCheckAtMs;
    if (elapsed < this.daemonRecheckIntervalMs) return;
    await this.probeDaemon();
  }

  isAvailable(): boolean {
    return this.available === true || this.daemonAvailable;
  }

  /** Debug string for troubleshooting availability issues. */
  debugStatus(): string {
    const cliPath = this.available ? this.qmdPath : (this.configuredQmdPath ?? "unavailable");
    const cliVersion = this.cliVersion ?? "unknown";
    const probeError = this.lastCliProbeError ? ` cliProbeError=${this.lastCliProbeError}` : "";
    return `cli=${this.available} daemon=${this.daemonAvailable} session=${!!this.daemonSession} cliPath=${cliPath} cliPathSource=${this.qmdPathSource} cliVersion=${cliVersion}${probeError}`;
  }

  isDaemonMode(): boolean {
    return this.daemonAvailable;
  }

  async search(
    query: string,
    collection?: string,
    maxResults?: number,
  ): Promise<QmdSearchResult[]> {
    if (!this.isAvailable()) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

    // Try daemon first (bypasses QMD_MUTEX — daemon handles its own concurrency)
    await this.maybeProbeDaemon();
    if (this.daemonAvailable) {
      const results = await this.searchViaDaemon(trimmed, col, n);
      if (results !== null) return results;
    }

    // Subprocess fallback
    return this.searchViaSubprocess(trimmed, col, n);
  }

  async searchGlobal(
    query: string,
    maxResults?: number,
  ): Promise<QmdSearchResult[]> {
    if (!this.isAvailable()) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const n = maxResults ?? 6;

    // Try daemon first
    await this.maybeProbeDaemon();
    if (this.daemonAvailable) {
      // Global search: no collection filter
      const results = await this.searchViaDaemon(trimmed, undefined, n);
      if (results !== null) return results;
    }

    // Subprocess fallback
    return this.searchGlobalViaSubprocess(trimmed, n);
  }

  /**
   * BM25 keyword search (fast, ~0.3s). Uses `qmd search`.
   */
  async bm25Search(
    query: string,
    collection?: string,
    maxResults?: number,
  ): Promise<QmdSearchResult[]> {
    if (!this.isAvailable()) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];
    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["search", trimmed, "-c", col, "--json", "-n", String(n)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      log.debug(`QMD bm25: ${Date.now() - startedAtMs}ms`);
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path: (entry.path as string) ?? (entry.docid as string) ?? "unknown",
          snippet: (entry.snippet as string) ?? "",
          score: typeof entry.score === "number" ? entry.score : 0,
        }),
      );
    } catch (err) {
      log.debug(`QMD bm25 search failed: ${err}`);
      return [];
    }
  }

  /**
   * Vector similarity search (~3-4s). Uses `qmd vsearch`.
   */
  async vectorSearch(
    query: string,
    collection?: string,
    maxResults?: number,
  ): Promise<QmdSearchResult[]> {
    if (!this.isAvailable()) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];
    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["vsearch", trimmed, "-c", col, "--json", "-n", String(n)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      log.debug(`QMD vsearch: ${Date.now() - startedAtMs}ms`);
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path: (entry.path as string) ?? (entry.docid as string) ?? "unknown",
          snippet: (entry.snippet as string) ?? "",
          score: typeof entry.score === "number" ? entry.score : 0,
        }),
      );
    } catch (err) {
      log.debug(`QMD vsearch failed: ${err}`);
      return [];
    }
  }

  /**
   * Hybrid search: runs BM25 + vector in parallel, merges/dedupes by path
   * keeping the best score and first non-empty snippet.
   */
  async hybridSearch(
    query: string,
    collection?: string,
    maxResults?: number,
  ): Promise<QmdSearchResult[]> {
    const n = maxResults ?? this.maxResults;
    const [bm25Results, vectorResults] = await Promise.all([
      this.bm25Search(query, collection, n),
      this.vectorSearch(query, collection, n),
    ]);

    // Merge by path, keeping best score
    const merged = new Map<string, QmdSearchResult>();
    for (const r of [...bm25Results, ...vectorResults]) {
      const key = r.path || r.docid;
      const existing = merged.get(key);
      if (!existing || r.score > existing.score) {
        merged.set(key, {
          ...r,
          snippet: r.snippet || existing?.snippet || "",
        });
      }
    }

    // Sort by score descending, take top N
    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  private async searchViaDaemon(
    query: string,
    collection: string | undefined,
    maxResults: number,
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = Date.now();
    try {
      const args: Record<string, unknown> = {
        query,
        num_results: maxResults,
      };
      if (collection) {
        args.collection = collection;
      }

      const result = await this.daemonSession.callTool("deep_search", args, QMD_DAEMON_TIMEOUT_MS);
      const durationMs = Date.now() - startedAtMs;

      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD daemon query: durationMs=${durationMs} collection=${collection ?? "global"} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      // Parse MCP tool result — content array with structuredContent
      const content = (result as any)?.content;
      if (!Array.isArray(content)) return null;

      const results: QmdSearchResult[] = [];
      for (const item of content) {
        // structuredContent contains the results
        const structured = item?.structuredContent ?? item;
        const docResults = structured?.results ?? structured?.documents;
        if (Array.isArray(docResults)) {
          for (const doc of docResults) {
            results.push({
              docid: typeof doc.docid === "string" ? doc.docid.replace(/^#/, "") : "",
              path: typeof doc.file === "string" ? doc.file : (typeof doc.docid === "string" ? doc.docid.replace(/^#/, "") : "unknown"),
              snippet: typeof doc.snippet === "string" ? doc.snippet : "",
              score: typeof doc.score === "number" ? doc.score : 0,
            });
          }
        }
        // Also handle text content with JSON
        if (typeof item?.text === "string") {
          try {
            const parsed = JSON.parse(item.text);
            const textResults = parsed?.results ?? parsed?.documents;
            if (Array.isArray(textResults)) {
              for (const doc of textResults) {
                results.push({
                  docid: typeof doc.docid === "string" ? doc.docid.replace(/^#/, "") : "",
                  path: typeof doc.file === "string" ? doc.file : (typeof doc.docid === "string" ? doc.docid.replace(/^#/, "") : "unknown"),
                  snippet: typeof doc.snippet === "string" ? doc.snippet : "",
                  score: typeof doc.score === "number" ? doc.score : 0,
                });
              }
            }
          } catch {
            // Not JSON text, ignore
          }
        }
      }

      log.debug(`QMD daemon search: ${results.length} results in ${durationMs}ms`);
      return results;
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      const errMsg = String(err);
      // Timeout or abort: don't invalidate session — daemon is still running,
      // just slow. Fall back to subprocess for this query only.
      if (errMsg.includes("AbortError") || errMsg.includes("abort") || errMsg.includes("timed out")) {
        log.debug(`QMD daemon search timed out after ${durationMs}ms, falling back to subprocess`);
        return null;
      }
      // Connection error: invalidate session and mark unavailable
      log.debug(`QMD daemon search failed after ${durationMs}ms: ${err}`);
      this.daemonSession.invalidate();
      this.daemonAvailable = false;
      return null;
    }
  }

  private async searchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];

    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["query", query, "-c", collection, "--json", "-n", String(maxResults)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD query: durationMs=${durationMs} collection=${collection} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return [];

      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path: (entry.path as string) ?? (entry.docid as string) ?? "unknown",
          snippet: (entry.snippet as string) ?? "",
          score: typeof entry.score === "number" ? entry.score : 0,
        }),
      );
    } catch (err) {
      log.debug(`QMD search failed: ${err}`);
      return [];
    }
  }

  private async searchGlobalViaSubprocess(
    query: string,
    maxResults: number,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];

    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["query", query, "--json", "-n", String(maxResults)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD global query: durationMs=${durationMs} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return [];

      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path: (entry.path as string) ?? (entry.docid as string) ?? "unknown",
          snippet: (entry.snippet as string) ?? "",
          score: typeof entry.score === "number" ? entry.score : 0,
        }),
      );
    } catch (err) {
      log.debug(`QMD global search failed: ${err}`);
      return [];
    }
  }

  async update(): Promise<void> {
    if (this.available === false) return;
    if (
      this.lastUpdateFailAtMs &&
      Date.now() - this.lastUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS
    ) {
      log.debug("QMD update: suppressed due to recent failures (backoff)");
      return;
    }
    try {
      const startedAtMs = Date.now();
      await runQmd(["update", "-c", this.collection], this.updateTimeoutMs, this.qmdPath);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(`SLOW QMD update: durationMs=${durationMs}`);
      }
      log.debug("QMD update completed");
    } catch (err) {
      this.lastUpdateFailAtMs = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`QMD update failed: ${msg}`);
    }
  }

  async embed(): Promise<void> {
    if (this.available === false) return;
    if (
      this.lastEmbedFailAtMs &&
      Date.now() - this.lastEmbedFailAtMs < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug("QMD embed: suppressed due to recent failures (backoff)");
      return;
    }
    try {
      const startedAtMs = Date.now();
      await runQmd(["embed", "-c", this.collection], 300_000, this.qmdPath);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(`SLOW QMD embed: durationMs=${durationMs}`);
      }
      log.debug("QMD embed completed");
    } catch (err) {
      this.lastEmbedFailAtMs = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`QMD embed failed: ${msg}`);
    }
  }

  async ensureCollection(memoryDir: string): Promise<"present" | "missing" | "unknown"> {
    if (this.available === false && !this.daemonAvailable) return "unknown";
    // If only daemon is available (no CLI), skip collection check
    if (this.available === false) return "unknown";
    try {
      const { stdout } = await runQmd(
        ["collection", "list"],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      // Parse text output: "openclaw-engram (qmd://openclaw-engram/)"
      const collectionRegex = new RegExp(
        `^${this.collection}\\s+\\(qmd://`,
        "m",
      );
      if (collectionRegex.test(stdout)) {
        return "present";
      }
    } catch (err) {
      // Treat command/probe failures as unknown so callers do not disable features
      // permanently after a transient CLI or daemon hiccup.
      log.warn(
        `QMD collection check unavailable for "${this.collection}" (will not disable features): ${err instanceof Error ? err.message : String(err)}`,
      );
      return "unknown";
    }

    log.info(
      `QMD collection "${this.collection}" not found. ` +
        `Add it to ~/.config/qmd/index.yml pointing at ${memoryDir}`,
    );
    return "missing";
  }
}
