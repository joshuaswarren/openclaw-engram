import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.js";
import type { QmdSearchResult } from "./types.js";

const QMD_TIMEOUT_MS = 30_000;
const QMD_DAEMON_TIMEOUT_MS = 60_000; // Longer timeout for daemon (first call may load models)
const QMD_PROBE_TIMEOUT_MS = 8_000;
const QMD_UPDATE_BACKOFF_MS = 15 * 60 * 1000; // 15m
const QMD_EMBED_BACKOFF_MS = 60 * 60 * 1000; // 60m
const QMD_CLI_WARN_THROTTLE_MS = 15 * 60 * 1000; // 15m
const QMD_FALLBACK_PATHS = [
  path.join(os.homedir(), ".bun", "bin", "qmd"),
  "/usr/local/bin/qmd",
  "/opt/homebrew/bin/qmd",
];
const QMD_GLOBAL_STATE_KEY = "__openclawEngramQmdGlobalState";

type QmdGlobalState = {
  warnedGlobalUpdateBehavior: boolean;
  lastGlobalUpdateRunAtMs: number | null;
  lastGlobalUpdateFailAtMs: number | null;
  lastGlobalEmbedRunAtMs: number | null;
  lastGlobalEmbedFailAtMs: number | null;
  lastCliWarnAtMs: number | null;
  lastUpdateByCollectionMs: Record<string, number>;
  lastUpdateFailByCollectionMs: Record<string, number>;
  lastEmbedByCollectionMs: Record<string, number>;
  lastEmbedFailByCollectionMs: Record<string, number>;
};

function getGlobalQmdState(): QmdGlobalState {
  const g = globalThis as any;
  if (!g[QMD_GLOBAL_STATE_KEY]) {
    g[QMD_GLOBAL_STATE_KEY] = {
      warnedGlobalUpdateBehavior: false,
      lastGlobalUpdateRunAtMs: null,
      lastGlobalUpdateFailAtMs: null,
      lastGlobalEmbedRunAtMs: null,
      lastGlobalEmbedFailAtMs: null,
      lastCliWarnAtMs: null,
      lastUpdateByCollectionMs: {},
      lastUpdateFailByCollectionMs: {},
      lastEmbedByCollectionMs: {},
      lastEmbedFailByCollectionMs: {},
    } satisfies QmdGlobalState;
  }
  return g[QMD_GLOBAL_STATE_KEY] as QmdGlobalState;
}

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
  private startPromise: Promise<boolean> | null = null;
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
      return true;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = (async () => {
      if (this.child) {
        this.cleanup({ killChild: true });
      }
      try {
        const child = spawn(this.qmdPath, ["mcp"], {
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        this.buffer = "";

        child.stdout?.on("data", (data: Buffer) => {
          if (this.child !== child) return;
          this.handleStdoutData(data);
        });
        child.stderr?.on("data", (data: Buffer) => {
          if (this.child !== child) return;
          const msg = data.toString().trim();
          if (msg) log.debug(`QMD mcp stderr: ${stripControlChars(msg)}`);
        });
        child.on("error", (err) => {
          if (this.child !== child) return;
          log.debug(`QMD mcp process error: ${err.message}`);
          this.cleanup({ child });
        });
        child.on("close", (code) => {
          if (this.child !== child) return;
          log.debug(`QMD mcp process exited (code ${code})`);
          this.cleanup({ child });
        });

        const result = await this.sendRequest(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "openclaw-engram", version: "1.0.0" },
          },
          15_000,
        );
        if (!result) {
          this.cleanup({ killChild: true, child });
          return false;
        }
        this.sendNotification("notifications/initialized");
        this.initialized = true;
        log.debug("QMD mcp: stdio session initialized");
        return true;
      } catch (err) {
        log.debug(`QMD mcp: failed to start stdio session: ${err}`);
        this.cleanup({ killChild: true });
        return false;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
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
    return this.sendRequest("tools/call", { name, arguments: args }, timeoutMs);
  }

  /** Kill stdio process and clear state so the next probe can restart. */
  invalidate(): void {
    this.cleanup({ killChild: true });
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
        reject(new Error(`QMD mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to write to QMD mcp stdin: ${err.message}`));
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
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        log.debug(`QMD mcp: unparseable stdout: ${truncateForLog(line, 200)}`);
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id as number);
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method) {
      log.debug(`QMD mcp notification: ${msg.method}`);
    }
  }

  private cleanup(opts?: { killChild?: boolean; child?: ChildProcess | null }): void {
    const target = opts?.child ?? this.child;
    if (!target) return;
    if (opts?.child && this.child !== opts.child) {
      return;
    }
    if (opts?.killChild && !target.killed) {
      target.kill("SIGTERM");
    }
    this.initialized = false;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("QMD mcp process terminated"));
    }
    this.pendingRequests.clear();
    this.startPromise = null;
    this.child = null;
    this.buffer = "";
  }
}

function parseMcpSearchResult(result: unknown): QmdSearchResult[] {
  const resultObj = result as Record<string, unknown> | null;
  if (!resultObj) return [];
  const results: QmdSearchResult[] = [];
  const pushDocs = (docs: unknown[]) => {
    for (const doc of docs) {
      const d = doc as Record<string, unknown>;
      results.push({
        docid: typeof d.docid === "string" ? d.docid.replace(/^#/, "") : "",
        path: typeof d.file === "string"
          ? d.file
          : (typeof d.docid === "string" ? d.docid.replace(/^#/, "") : "unknown"),
        snippet: typeof d.snippet === "string" ? d.snippet : "",
        score: typeof d.score === "number" ? d.score : 0,
      });
    }
  };
  const topStructured = resultObj.structuredContent as Record<string, unknown> | undefined;
  const topDocs = topStructured?.results ?? topStructured?.documents;
  if (Array.isArray(topDocs)) pushDocs(topDocs);
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
        } catch {
          // ignore non-json text
        }
      }
    }
  }
  return results;
}

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
  private lastUpdateRunAtMs: number | null = null;
  private readonly updateTimeoutMs: number;
  private readonly updateMinIntervalMs: number;
  private readonly slowLog?: { enabled: boolean; thresholdMs: number };
  private readonly configuredQmdPath?: string;
  private qmdPathSource: "auto-path" | "auto-fallback" | "configured" = "auto-path";
  private cliVersion: string | null = null;
  private lastCliProbeError: string | null = null;

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
      updateMinIntervalMs?: number;
      qmdPath?: string;
      daemonUrl?: string;
      daemonRecheckIntervalMs?: number;
    },
  ) {
    this.slowLog = opts?.slowLog;
    this.updateTimeoutMs = opts?.updateTimeoutMs ?? 120_000;
    this.updateMinIntervalMs = Math.max(0, opts?.updateMinIntervalMs ?? 15 * 60_000);
    this.configuredQmdPath = opts?.qmdPath?.trim() ? opts.qmdPath.trim() : undefined;
    this.daemonEnabled = Boolean(opts?.daemonUrl);
    this.daemonRecheckIntervalMs = opts?.daemonRecheckIntervalMs ?? 60_000;
  }

  private qmdPath: string = "qmd";

  async probe(): Promise<boolean> {
    const cliOk = await this.probeCli();
    if (this.daemonEnabled && cliOk) {
      await this.probeDaemon();
    }
    return cliOk || this.daemonAvailable;
  }

  private async probeDaemon(): Promise<boolean> {
    this.lastDaemonCheckAtMs = Date.now();
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
        const result = await runQmd(["--version"], QMD_PROBE_TIMEOUT_MS, this.configuredQmdPath);
        this.available = true;
        this.qmdPath = this.configuredQmdPath;
        this.qmdPathSource = "configured";
        this.cliVersion = parseVersion(result.stdout, result.stderr);
        this.lastCliProbeError = null;
        return true;
      } catch (err) {
        markProbeFailure(err);
        // Do not hard-fail here: fall through to PATH/fallback probing.
        // This keeps recall healthy even when configured path is stale.
        this.logCliProbeWarning(
          `QMD: configured qmdPath failed (${this.configuredQmdPath}): ${this.lastCliProbeError}`,
        );
      }
    }

    // Try PATH first
    try {
      const result = await runQmd(["--version"], QMD_PROBE_TIMEOUT_MS, "qmd");
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
          const result = await runQmd(["--version"], QMD_PROBE_TIMEOUT_MS, fallbackPath);
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

  private logCliProbeWarning(message: string): void {
    const state = getGlobalQmdState();
    const now = Date.now();
    const canWarn =
      state.lastCliWarnAtMs === null || now - state.lastCliWarnAtMs >= QMD_CLI_WARN_THROTTLE_MS;
    if (!canWarn) {
      log.debug(message);
      return;
    }
    state.lastCliWarnAtMs = now;
    if (this.daemonAvailable) {
      // Daemon mode is healthy; keep this as debug noise rather than warning.
      log.debug(message);
      return;
    }
    log.warn(message);
  }

  /** Re-probe daemon if it was down and recheck interval has elapsed. */
  private async maybeProbeDaemon(): Promise<void> {
    if (!this.daemonEnabled) return;
    // If daemon is marked healthy and session is active, nothing to do.
    if (this.daemonAvailable && this.daemonSession?.isActive()) return;
    // If recently checked and failed, respect the recheck interval.
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
      if (results !== null) {
        if (results.length > 0) return results;
        // Fail-open: daemon sometimes returns zero hits while subprocess
        // query expansion/rerank still finds relevant docs.
        log.debug("QMD daemon search returned 0 results; falling back to subprocess query");
      }
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
      if (results !== null) {
        if (results.length > 0) return results;
        log.debug("QMD daemon global search returned 0 results; falling back to subprocess query");
      }
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

    // Try daemon first — BM25 via daemon is much faster than subprocess.
    await this.maybeProbeDaemon();
    if (this.daemonAvailable && this.daemonSession) {
      const results = await this.bm25SearchViaDaemon(trimmed, col, n);
      if (results !== null) {
        if (results.length > 0) return results;
        log.debug("QMD daemon bm25 returned 0 results; falling back to subprocess query");
      }
    }
    return this.bm25SearchViaSubprocess(trimmed, col, n);
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

    // Try daemon first — keeps models warm, avoids cold subprocess loads.
    await this.maybeProbeDaemon();
    if (this.daemonAvailable && this.daemonSession) {
      const results = await this.vsearchViaDaemon(trimmed, col, n);
      if (results !== null) {
        if (results.length > 0) return results;
        log.debug("QMD daemon vsearch returned 0 results; falling back to subprocess query");
      }
    }
    return this.vsearchViaSubprocess(trimmed, col, n);
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
    const trimmed = query.trim();
    if (!trimmed) return [];

    const [bm25Results, vectorResults] = await Promise.all([
      this.bm25Search(trimmed, collection, n),
      this.vectorSearch(trimmed, collection, n),
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
      // Connection error: mark unavailable, maybeProbeDaemon() will restart.
      log.debug(`QMD daemon search failed after ${durationMs}ms: ${err}`);
      this.daemonSession.invalidate();
      this.daemonAvailable = false;
      return null;
    }
  }

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
        QMD_DAEMON_TIMEOUT_MS,
      );
      const durationMs = Date.now() - startedAtMs;
      const results = parseMcpSearchResult(result);
      log.debug(`QMD daemon bm25: ${results.length} results in ${durationMs}ms`);
      return results;
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      const errMsg = String(err);
      if (errMsg.includes("AbortError") || errMsg.includes("abort") || errMsg.includes("timed out")) {
        log.debug(`QMD daemon bm25 timed out after ${durationMs}ms, falling back to subprocess`);
        return null;
      }
      log.debug(`QMD daemon bm25 failed after ${durationMs}ms: ${err}`);
      this.daemonSession.invalidate();
      this.daemonAvailable = false;
      return null;
    }
  }

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
        log.debug("QMD daemon vsearch timed out, falling back to subprocess");
        return null;
      }
      log.debug(`QMD daemon vsearch failed: ${err}`);
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

      const trimmedOut = stdout.trim();
      if (!trimmedOut || trimmedOut === "No results found.") return [];
      const parsed = JSON.parse(trimmedOut);
      if (!Array.isArray(parsed)) return [];

      return parsed.map(
        (entry: Record<string, unknown>): QmdSearchResult => ({
          docid: (entry.docid as string) ?? "",
          path:
            (entry.file as string) ??
            (entry.path as string) ??
            (entry.docid as string) ??
            "unknown",
          snippet: (entry.snippet as string) ?? "",
          score: typeof entry.score === "number" ? entry.score : 0,
        }),
      );
    } catch (err) {
      log.debug(`QMD search failed: ${err}`);
      return [];
    }
  }

  private async bm25SearchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["search", query, "-c", collection, "--json", "-n", String(maxResults)],
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
          path:
            (entry.file as string) ??
            (entry.path as string) ??
            (entry.docid as string) ??
            "unknown",
          snippet: (entry.snippet as string) ?? "",
          score: typeof entry.score === "number" ? entry.score : 0,
        }),
      );
    } catch (err) {
      log.debug(`QMD bm25 search failed: ${err}`);
      return [];
    }
  }

  private async vsearchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["vsearch", query, "-c", collection, "--json", "-n", String(maxResults)],
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
          path:
            (entry.file as string) ??
            (entry.path as string) ??
            (entry.docid as string) ??
            "unknown",
          snippet: (entry.snippet as string) ?? "",
          score: typeof entry.score === "number" ? entry.score : 0,
        }),
      );
    } catch (err) {
      log.debug(`QMD vsearch failed: ${err}`);
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
          path:
            (entry.file as string) ??
            (entry.path as string) ??
            (entry.docid as string) ??
            "unknown",
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
    await this.runUpdateForCollection(this.collection, { perCollectionThrottle: false });
  }

  async updateCollection(collection: string): Promise<void> {
    await this.runUpdateForCollection(collection, { perCollectionThrottle: true });
  }

  private async runUpdateForCollection(
    collection: string,
    options: { perCollectionThrottle: boolean },
  ): Promise<void> {
    if (this.available === false) return;
    const name = collection.trim();
    if (!name) return;
    const globalState = getGlobalQmdState();
    const now = Date.now();
    if (options.perCollectionThrottle) {
      if (
        globalState.lastGlobalUpdateFailAtMs &&
        now - globalState.lastGlobalUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS
      ) {
        log.debug("QMD update: suppressed by global failure backoff");
        return;
      }
      const lastCollectionRun = globalState.lastUpdateByCollectionMs[name];
      if (
        Number.isFinite(lastCollectionRun) &&
        now - lastCollectionRun < this.updateMinIntervalMs
      ) {
        log.debug(`QMD update: suppressed by per-collection min-interval gate (${name})`);
        return;
      }
      const lastCollectionFail = globalState.lastUpdateFailByCollectionMs[name];
      if (
        Number.isFinite(lastCollectionFail) &&
        now - lastCollectionFail < QMD_UPDATE_BACKOFF_MS
      ) {
        log.debug(`QMD update: suppressed by per-collection failure backoff (${name})`);
        return;
      }
    } else {
      if (
        this.lastUpdateRunAtMs &&
        now - this.lastUpdateRunAtMs < this.updateMinIntervalMs
      ) {
        log.debug("QMD update: suppressed due to min-interval gate");
        return;
      }
      if (
        this.lastUpdateFailAtMs &&
        now - this.lastUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS
      ) {
        log.debug("QMD update: suppressed due to recent failures (backoff)");
        return;
      }
      if (
        globalState.lastGlobalUpdateRunAtMs &&
        now - globalState.lastGlobalUpdateRunAtMs < this.updateMinIntervalMs
      ) {
        log.debug("QMD update: suppressed by global min-interval gate");
        return;
      }
      if (
        globalState.lastGlobalUpdateFailAtMs &&
        now - globalState.lastGlobalUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS
      ) {
        log.debug("QMD update: suppressed by global failure backoff");
        return;
      }
    }
    try {
      if (!globalState.warnedGlobalUpdateBehavior) {
        globalState.warnedGlobalUpdateBehavior = true;
        log.warn(
          "QMD update runs globally across collections in current CLI versions; Engram now rate-limits update calls to reduce gateway load.",
        );
      }
      const startedAtMs = Date.now();
      await runQmd(["update", "-c", name], this.updateTimeoutMs, this.qmdPath);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(`SLOW QMD update: durationMs=${durationMs}`);
      }
      const at = Date.now();
      if (options.perCollectionThrottle) {
        globalState.lastUpdateByCollectionMs[name] = at;
        globalState.lastGlobalUpdateRunAtMs = at;
      } else {
        this.lastUpdateRunAtMs = at;
        globalState.lastGlobalUpdateRunAtMs = at;
      }
      log.debug(`QMD update completed for collection=${name}`);
    } catch (err) {
      const at = Date.now();
      if (options.perCollectionThrottle) {
        globalState.lastUpdateFailByCollectionMs[name] = at;
        globalState.lastGlobalUpdateFailAtMs = at;
      } else {
        this.lastUpdateFailAtMs = at;
        globalState.lastGlobalUpdateFailAtMs = at;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`QMD update failed for collection ${name}: ${msg}`);
    }
  }

  async embed(): Promise<void> {
    if (this.available === false) return;
    const globalState = getGlobalQmdState();
    if (
      this.lastEmbedFailAtMs &&
      Date.now() - this.lastEmbedFailAtMs < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug("QMD embed: suppressed due to recent failures (backoff)");
      return;
    }
    if (
      globalState.lastGlobalEmbedRunAtMs &&
      Date.now() - globalState.lastGlobalEmbedRunAtMs < this.updateMinIntervalMs
    ) {
      log.debug("QMD embed: suppressed by global min-interval gate");
      return;
    }
    if (
      globalState.lastGlobalEmbedFailAtMs &&
      Date.now() - globalState.lastGlobalEmbedFailAtMs < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug("QMD embed: suppressed by global failure backoff");
      return;
    }
    try {
      const startedAtMs = Date.now();
      await runQmd(["embed", "-c", this.collection], 300_000, this.qmdPath);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(`SLOW QMD embed: durationMs=${durationMs}`);
      }
      globalState.lastGlobalEmbedRunAtMs = Date.now();
      log.debug("QMD embed completed");
    } catch (err) {
      const now = Date.now();
      this.lastEmbedFailAtMs = now;
      globalState.lastGlobalEmbedFailAtMs = now;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`QMD embed failed: ${msg}`);
    }
  }

  async embedCollection(collection: string): Promise<void> {
    if (this.available === false) return;
    const name = collection.trim();
    if (!name) return;
    const globalState = getGlobalQmdState();
    const now = Date.now();
    if (
      globalState.lastGlobalEmbedFailAtMs &&
      now - globalState.lastGlobalEmbedFailAtMs < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug(`QMD embed: suppressed by global failure backoff (${name})`);
      return;
    }
    const lastCollectionRun = globalState.lastEmbedByCollectionMs[name];
    if (
      Number.isFinite(lastCollectionRun) &&
      now - lastCollectionRun < this.updateMinIntervalMs
    ) {
      log.debug(`QMD embed: suppressed by per-collection min-interval gate (${name})`);
      return;
    }
    const lastCollectionFail = globalState.lastEmbedFailByCollectionMs[name];
    if (
      Number.isFinite(lastCollectionFail) &&
      now - lastCollectionFail < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug(`QMD embed: suppressed by per-collection failure backoff (${name})`);
      return;
    }
    try {
      await runQmd(["embed", "-c", name], 300_000, this.qmdPath);
      const at = Date.now();
      globalState.lastEmbedByCollectionMs[name] = at;
      globalState.lastGlobalEmbedRunAtMs = at;
    } catch (err) {
      const at = Date.now();
      globalState.lastEmbedFailByCollectionMs[name] = at;
      globalState.lastGlobalEmbedFailAtMs = at;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`QMD embed failed for collection ${name}: ${msg}`);
    }
  }

  async ensureCollection(memoryDir: string): Promise<"present" | "missing" | "unknown" | "skipped"> {
    if (this.available === false && !this.daemonAvailable) return "unknown";
    // If only daemon is available (no CLI), skip collection check
    if (this.available === false) return "skipped";
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
      log.debug(
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
