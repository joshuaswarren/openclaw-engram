import { spawn, type ChildProcess } from "node:child_process";
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
// QMD Stdio Daemon Session (MCP over stdio child process)
// ---------------------------------------------------------------------------

let nextJsonRpcId = 1;

class QmdDaemonSession {
  private child: ChildProcess | null = null;
  private initialized = false;
  private buffer = "";
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly qmdPath: string;

  constructor(qmdPath: string) {
    this.qmdPath = qmdPath;
  }

  /** Spawn the qmd mcp child process and perform MCP handshake. */
  async start(): Promise<boolean> {
    if (this.child && !this.child.killed && this.initialized) {
      return true; // Already running and initialized
    }

    // Clean up any dead process
    if (this.child) {
      this.cleanup();
    }

    try {
      this.child = spawn(this.qmdPath, ["mcp"], {
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.buffer = "";

      this.child.stdout!.on("data", (data: Buffer) => {
        this.handleStdoutData(data);
      });

      this.child.stderr!.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log.debug(`QMD mcp stderr: ${stripControlChars(msg)}`);
      });

      this.child.on("error", (err) => {
        log.debug(`QMD mcp process error: ${err.message}`);
        this.cleanup();
      });

      this.child.on("close", (code) => {
        log.debug(`QMD mcp process exited (code ${code})`);
        this.cleanup();
      });

      // MCP handshake
      return await this.mcpInitialize();
    } catch (err) {
      log.debug(`QMD mcp: failed to spawn: ${err}`);
      this.cleanup();
      return false;
    }
  }

  private async mcpInitialize(): Promise<boolean> {
    try {
      const result = await this.sendRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "openclaw-engram", version: "1.0.0" },
        },
        15_000,
      );

      if (!result) return false;

      // Send initialized notification (no response expected)
      this.sendNotification("notifications/initialized");

      this.initialized = true;
      log.debug("QMD mcp: stdio session initialized");
      return true;
    } catch (err) {
      log.debug(`QMD mcp: initialize failed: ${err}`);
      return false;
    }
  }

  /** Call an MCP tool and return the parsed result. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number = 30_000,
  ): Promise<unknown> {
    if (!this.child || this.child.killed || !this.initialized) {
      throw new Error("QMD mcp process not running");
    }

    const result = await this.sendRequest(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );

    return result;
  }

  /** Kill the child process and clear session state. */
  invalidate(): void {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.cleanup();
  }

  isActive(): boolean {
    return this.child !== null && !this.child.killed && this.initialized;
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin || this.child.killed) {
        reject(new Error("QMD mcp process not available"));
        return;
      }

      const id = nextJsonRpcId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(`QMD mcp ${method} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const message =
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      this.child.stdin.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(
            new Error(`Failed to write to QMD mcp stdin: ${err.message}`),
          );
        }
      });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin || this.child.killed) return;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params) msg.params = params;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleStdoutData(data: Buffer): void {
    this.buffer += data.toString();

    // Process complete lines (NDJSON)
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        log.debug(
          `QMD mcp: unparseable stdout: ${truncateForLog(line, 200)}`,
        );
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // JSON-RPC response (has id) — route to pending request
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id as number);
        if (msg.error) {
          pending.reject(
            new Error(JSON.stringify(msg.error)),
          );
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // JSON-RPC notification (no id) — log and ignore
    if (msg.method) {
      log.debug(`QMD mcp notification: ${msg.method}`);
    }
  }

  private cleanup(): void {
    this.initialized = false;
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("QMD mcp process terminated"));
    }
    this.pendingRequests.clear();
    this.child = null;
    this.buffer = "";
  }
}

// ---------------------------------------------------------------------------
// MCP tool result parser (shared by all daemon search methods)
// ---------------------------------------------------------------------------

function parseMcpSearchResult(result: unknown): QmdSearchResult[] {
  const resultObj = result as Record<string, unknown> | null;
  if (!resultObj) return [];

  const results: QmdSearchResult[] = [];
  const pushDocs = (docs: unknown[]) => {
    for (const doc of docs) {
      const d = doc as Record<string, unknown>;
      results.push({
        docid: typeof d.docid === "string" ? d.docid.replace(/^#/, "") : "",
        path: typeof d.file === "string" ? d.file : (typeof d.docid === "string" ? d.docid.replace(/^#/, "") : "unknown"),
        snippet: typeof d.snippet === "string" ? d.snippet : "",
        score: typeof d.score === "number" ? d.score : 0,
      });
    }
  };

  // Top-level structuredContent
  const topStructured = resultObj.structuredContent as Record<string, unknown> | undefined;
  const topDocs = topStructured?.results ?? topStructured?.documents;
  if (Array.isArray(topDocs)) pushDocs(topDocs);

  // Content array items (text or nested structuredContent)
  const content = resultObj.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const structured = item?.structuredContent;
      const docResults = structured?.results ?? structured?.documents;
      if (Array.isArray(docResults)) pushDocs(docResults);
      if (typeof item?.text === "string") {
        try {
          const parsed = JSON.parse(item.text);
          const textResults = parsed?.results ?? parsed?.documents;
          if (Array.isArray(textResults)) pushDocs(textResults);
        } catch { /* Not JSON text */ }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Shared daemon session (singleton — one child process for all collections)
// ---------------------------------------------------------------------------

let _sharedDaemonSession: QmdDaemonSession | null = null;

function getSharedDaemonSession(qmdPath: string): QmdDaemonSession {
  if (!_sharedDaemonSession) {
    _sharedDaemonSession = new QmdDaemonSession(qmdPath);
  }
  return _sharedDaemonSession;
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

  // Daemon mode fields
  private daemonSession: QmdDaemonSession | null = null;
  private daemonAvailable = false;
  private lastDaemonCheckAtMs = 0;
  private readonly daemonEnabled: boolean;
  private readonly daemonRecheckIntervalMs: number;

  constructor(
    private readonly collection: string,
    private readonly maxResults: number,
    opts?: {
      slowLog?: { enabled: boolean; thresholdMs: number };
      updateTimeoutMs?: number;
      daemonEnabled?: boolean;
      daemonRecheckIntervalMs?: number;
    },
  ) {
    this.slowLog = opts?.slowLog;
    this.updateTimeoutMs = opts?.updateTimeoutMs ?? 120_000;
    this.daemonEnabled = opts?.daemonEnabled ?? false;
    this.daemonRecheckIntervalMs = opts?.daemonRecheckIntervalMs ?? 60_000;
  }

  private qmdPath: string = "qmd";

  async probe(): Promise<boolean> {
    // Always probe CLI first — we need the binary path for daemon mode too
    const cliOk = await this.probeCli();

    // Start stdio daemon session if enabled and we found the binary
    if (this.daemonEnabled && cliOk) {
      await this.probeDaemon();
    }

    return cliOk || this.daemonAvailable;
  }

  private async probeDaemon(): Promise<boolean> {
    this.lastDaemonCheckAtMs = Date.now();

    // Use shared singleton — all QmdClient instances share one child process
    this.daemonSession = getSharedDaemonSession(this.qmdPath);

    try {
      const ok = await this.daemonSession.start();
      if (!ok) {
        log.debug("QMD daemon: stdio session failed to start");
        this.daemonAvailable = false;
        return false;
      }
      log.info(`QMD daemon: stdio session active (collection=${this.collection})`);
      this.daemonAvailable = true;
      return true;
    } catch (err) {
      log.debug(`QMD daemon: probe failed: ${err}`);
      this.daemonAvailable = false;
      return false;
    }
  }

  private async probeCli(): Promise<boolean> {
    // Try PATH first
    try {
      await runQmd(["--version"], 3000, "qmd");
      this.available = true;
      this.qmdPath = "qmd";
      return true;
    } catch {
      // Try fallback paths
      for (const fallbackPath of QMD_FALLBACK_PATHS) {
        try {
          await runQmd(["--version"], 3000, fallbackPath);
          this.available = true;
          this.qmdPath = fallbackPath;
          log.info(`QMD: found at ${fallbackPath}`);
          return true;
        } catch {
          // Continue to next fallback
        }
      }
      this.available = false;
      return false;
    }
  }

  /** Re-probe daemon if it was down and recheck interval has elapsed. */
  private async maybeProbeDaemon(): Promise<void> {
    if (!this.daemonEnabled) return;
    // If still active, nothing to do
    if (this.daemonSession?.isActive()) return;
    // If recently checked and failed, respect the recheck interval
    if (this.daemonAvailable === false) {
      const elapsed = Date.now() - this.lastDaemonCheckAtMs;
      if (elapsed < this.daemonRecheckIntervalMs) return;
    }
    this.daemonAvailable = false;
    await this.probeDaemon();
  }

  isAvailable(): boolean {
    return this.available === true || this.daemonAvailable;
  }

  /** Debug string for troubleshooting availability issues. */
  debugStatus(): string {
    return `cli=${this.available} daemon=${this.daemonAvailable} session=${!!this.daemonSession}`;
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

    // Try daemon first — BM25 via daemon is ~2ms vs ~100ms subprocess
    await this.maybeProbeDaemon();
    if (this.daemonAvailable && this.daemonSession) {
      const results = await this.bm25SearchViaDaemon(trimmed, col, n);
      if (results !== null) return results;
    }

    // Subprocess fallback
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["search", trimmed, "-c", col, "--json", "-n", String(n)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      log.debug(`QMD bm25: ${Date.now() - startedAtMs}ms`);
      const trimmedOut = stdout.trim();
      if (!trimmedOut || trimmedOut === "No results found.") return [];
      const parsed = JSON.parse(trimmedOut);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path: (entry.file as string) ?? (entry.path as string) ?? (entry.docid as string) ?? "unknown",
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

    // Try daemon first — keeps models warm, avoids cold subprocess loads
    await this.maybeProbeDaemon();
    if (this.daemonAvailable && this.daemonSession) {
      const results = await this.vsearchViaDaemon(trimmed, col, n);
      if (results !== null) return results;
    }

    // Subprocess fallback
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["vsearch", trimmed, "-c", col, "--json", "-n", String(n)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      log.debug(`QMD vsearch: ${Date.now() - startedAtMs}ms`);
      const trimmedOut = stdout.trim();
      if (!trimmedOut || trimmedOut === "No results found.") return [];
      const parsed = JSON.parse(trimmedOut);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path: (entry.file as string) ?? (entry.path as string) ?? (entry.docid as string) ?? "unknown",
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
        limit: maxResults,
      };
      if (collection) {
        args.collection = collection;
      }

      const result = await this.daemonSession.callTool("query", args, QMD_DAEMON_TIMEOUT_MS);
      const durationMs = Date.now() - startedAtMs;

      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD daemon query: durationMs=${durationMs} collection=${collection ?? "global"} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      const results = parseMcpSearchResult(result);

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
      // Connection error: mark unavailable, maybeProbeDaemon() will restart
      // Don't invalidate shared session — other clients may still be using it
      log.debug(`QMD daemon search failed after ${durationMs}ms: ${err}`);
      this.daemonAvailable = false;
      return null;
    }
  }

  /** BM25 search via daemon — fast (~2ms), no model loading. */
  private async bm25SearchViaDaemon(
    query: string,
    collection: string,
    maxResults: number,
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = Date.now();
    try {
      const result = await this.daemonSession.callTool(
        "search",
        { query, limit: maxResults, collection },
        QMD_TIMEOUT_MS,
      );
      const durationMs = Date.now() - startedAtMs;

      const results = parseMcpSearchResult(result);

      log.debug(`QMD daemon bm25: ${results.length} results in ${durationMs}ms`);
      return results;
    } catch (err) {
      log.debug(`QMD daemon bm25 failed: ${err}`);
      return null;
    }
  }

  /** Vector search via daemon — uses warm models (~100-500ms vs 8-28s cold subprocess). */
  private async vsearchViaDaemon(
    query: string,
    collection: string,
    maxResults: number,
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = Date.now();
    try {
      const result = await this.daemonSession.callTool(
        "vsearch",
        { query, limit: maxResults, collection },
        QMD_DAEMON_TIMEOUT_MS,
      );
      const durationMs = Date.now() - startedAtMs;

      const results = parseMcpSearchResult(result);

      log.debug(`QMD daemon vsearch: ${results.length} results in ${durationMs}ms`);
      return results;
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("timed out")) {
        log.debug(`QMD daemon vsearch timed out, falling back to subprocess`);
        return null;
      }
      log.debug(`QMD daemon vsearch failed: ${err}`);
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

      const trimmedOut = stdout.trim();
      if (!trimmedOut || trimmedOut === "No results found.") return [];
      const parsed = JSON.parse(trimmedOut);
      if (!Array.isArray(parsed)) return [];

      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path: (entry.file as string) ?? (entry.path as string) ?? (entry.docid as string) ?? "unknown",
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

      const trimmedOut = stdout.trim();
      if (!trimmedOut || trimmedOut === "No results found.") return [];
      const parsed = JSON.parse(trimmedOut);
      if (!Array.isArray(parsed)) return [];

      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path: (entry.file as string) ?? (entry.path as string) ?? (entry.docid as string) ?? "unknown",
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
      await runQmd(["update"], this.updateTimeoutMs, this.qmdPath);
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
      await runQmd(["embed"], 300_000, this.qmdPath);
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

  async ensureCollection(memoryDir: string): Promise<boolean> {
    if (this.available === false && !this.daemonAvailable) return false;
    // If only daemon is available (no CLI), skip collection check
    if (this.available === false) return true;
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
        return true;
      }
    } catch {
      // collection list command failed
    }

    log.info(
      `QMD collection "${this.collection}" not found. ` +
        `Add it to ~/.config/qmd/index.yml pointing at ${memoryDir}`,
    );
    return false;
  }
}
