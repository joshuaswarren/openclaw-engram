import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.js";
import type { QmdSearchExplain, QmdSearchResult } from "./types.js";
import type { SearchBackend, SearchExecutionOptions, SearchQueryOptions } from "./search/port.js";

export interface QmdClientOptions {
  slowLog?: { enabled: boolean; thresholdMs: number };
  updateTimeoutMs?: number;
  updateMinIntervalMs?: number;
  qmdPath?: string;
  daemonUrl?: string;
  daemonRecheckIntervalMs?: number;
}

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

function abortError(message: string): Error {
  const err = new Error(message);
  Object.defineProperty(err, "name", { value: "AbortError" });
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

function isCallerCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (isAbortError(err)) return true;
  if (err && typeof err === "object") {
    const code = "code" in err ? (err as { code?: unknown }).code : undefined;
    if (code === "ABORT_ERR" || code === "ERR_CANCELED") return true;
  }
  return /\b(aborted|cancell?ed)\b/i.test(errorMessage(err));
}

function isDaemonTimeoutError(err: unknown): boolean {
  return /timed out/i.test(errorMessage(err));
}

function throwIfAborted(signal?: AbortSignal, message = "operation aborted"): void {
  if (signal?.aborted) {
    throw abortError(message);
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError("operation aborted while waiting"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

function isVectorDimensionMismatchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /dimension mismatch/i.test(msg) ||
    (/vectors?_vec/i.test(msg) && /float\[\d+\]/i.test(msg)) ||
    (/embedding/i.test(msg) && /dimensions?/i.test(msg))
  );
}

function parseQmdVersion(version: string | null): [number, number, number] | null {
  if (!version) return null;
  const match = version.match(/v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return [
    Number.parseInt(match[1] ?? "0", 10),
    Number.parseInt(match[2] ?? "0", 10),
    Number.parseInt(match[3] ?? "0", 10),
  ];
}

function versionAtLeast(
  current: [number, number, number] | null,
  target: [number, number, number],
): boolean {
  if (!current) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((current[i] ?? 0) > target[i]) return true;
    if ((current[i] ?? 0) < target[i]) return false;
  }
  return true;
}

function normalizeSearchOptions(options?: SearchQueryOptions): SearchQueryOptions | undefined {
  if (!options) return undefined;
  const intent = typeof options.intent === "string" ? options.intent.trim() : "";
  const normalized: SearchQueryOptions = {};
  if (intent.length > 0) {
    normalized.intent = intent;
  }
  if (options.explain === true) {
    normalized.explain = true;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseExplainScores(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scores = value.filter((entry): entry is number => typeof entry === "number");
  return scores.length > 0 ? scores : undefined;
}

export function parseQmdExplain(value: unknown): QmdSearchExplain | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const parsed: QmdSearchExplain = {
    ftsScores: parseExplainScores(candidate.ftsScores),
    vectorScores: parseExplainScores(candidate.vectorScores),
    rrf: typeof candidate.rrf === "number" ? candidate.rrf : undefined,
    rerankScore: typeof candidate.rerankScore === "number" ? candidate.rerankScore : undefined,
    blendedScore: typeof candidate.blendedScore === "number" ? candidate.blendedScore : undefined,
  };
  return Object.values(parsed).some((entry) => entry !== undefined) ? parsed : undefined;
}

class AsyncMutex {
  private locked = false;
  private queue: Array<{
    resolve: (release: () => void) => void;
    reject: (reason: Error) => void;
    signal?: AbortSignal;
    onAbort: () => void;
  }> = [];

  async runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (release: () => void) => {
          signal?.removeEventListener("abort", waiter.onAbort);
          resolve(release);
        },
        reject: (reason: Error) => {
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(reason);
        },
        signal,
        onAbort: () => {
          this.queue = this.queue.filter((entry) => entry !== waiter);
          reject(abortError("operation aborted while waiting for qmd mutex"));
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      if (next.signal?.aborted) {
        next.reject(abortError("operation aborted while waiting for qmd mutex"));
        continue;
      }
      this.locked = true;
      next.resolve(() => this.release());
      return;
    }
    this.locked = false;
  }
}

const QMD_MUTEX = new AsyncMutex();

function runQmd(
  args: string[],
  timeoutMs: number = QMD_TIMEOUT_MS,
  qmdPath: string = "qmd",
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  // Serialize all qmd calls. This avoids SQLite lock contention when multiple
  // channels/agents trigger QMD operations at nearly the same time.
  return QMD_MUTEX.runExclusive(async () => {
    throwIfAborted(signal, `qmd ${args.join(" ")} aborted before start`);
    const maxAttempts = isLikelyWriteCommand(args) ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await runQmdOnce(args, timeoutMs, qmdPath, signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts && isSqliteBusyError(msg)) {
          // Another qmd call (or an external qmd process) currently holds the DB.
          // Back off briefly and retry.
          await sleepWithSignal(1500 * attempt, signal);
          continue;
        }
        throw err;
      }
    }
    // unreachable
    throw new Error("qmd command failed");
  }, signal);
}

function isLikelyWriteCommand(args: string[]): boolean {
  const cmd = args[0] ?? "";
  return cmd === "update" || cmd === "embed" || cmd === "cleanup" || cmd === "collection";
}

function runQmdOnce(
  args: string[],
  timeoutMs: number,
  qmdPath: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal, `qmd ${args.join(" ")} aborted before spawn`);
    const child = spawn(qmdPath, args, {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      child.kill("SIGKILL");
      reject(new Error(`qmd ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      child.kill("SIGKILL");
      reject(abortError(`qmd ${args.join(" ")} aborted`));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.child || this.child.killed || !this.initialized) {
      throw new Error("QMD mcp process not running");
    }
    return this.sendRequest("tools/call", { name, arguments: args }, timeoutMs, signal);
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      throwIfAborted(signal, `QMD mcp ${method} aborted before request`);
      if (!this.child || !this.child.stdin || this.child.killed) {
        reject(new Error("QMD mcp process not available"));
        return;
      }

      const id = nextJsonRpcId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        cleanup();
        reject(new Error(`QMD mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        cleanup();
        reject(abortError(`QMD mcp ${method} aborted`));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      this.pendingRequests.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", onAbort, { once: true });
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          cleanup();
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

function parseMcpSearchResult(
  result: unknown,
  transport: QmdSearchResult["transport"] = "daemon",
): QmdSearchResult[] {
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
          : typeof d.path === "string"
          ? d.path
          : (typeof d.docid === "string" ? d.docid.replace(/^#/, "") : "unknown"),
        snippet: typeof d.snippet === "string" ? d.snippet : "",
        score: typeof d.score === "number" ? d.score : 0,
        explain: parseQmdExplain(d.explain),
        transport,
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

function parseQmdSearchStdout(
  stdout: string,
  transport: QmdSearchResult["transport"] = "subprocess",
): QmdSearchResult[] {
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
      explain: parseQmdExplain(entry.explain),
      transport,
    }),
  );
}

let _sharedDaemonSession: QmdDaemonSession | null = null;
let _sharedDaemonSessionPath: string | null = null;

function getSharedDaemonSession(qmdPath: string): QmdDaemonSession {
  const normalizedPath = qmdPath.trim() || "qmd";
  if (_sharedDaemonSession && _sharedDaemonSessionPath !== normalizedPath) {
    _sharedDaemonSession.invalidate();
    _sharedDaemonSession = null;
    _sharedDaemonSessionPath = null;
  }
  if (!_sharedDaemonSession) {
    _sharedDaemonSession = new QmdDaemonSession(normalizedPath);
    _sharedDaemonSessionPath = normalizedPath;
  }
  return _sharedDaemonSession;
}

// ---------------------------------------------------------------------------
// QmdClient
// ---------------------------------------------------------------------------

export class QmdClient implements SearchBackend {
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
    opts?: QmdClientOptions,
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
    if (this.daemonEnabled) {
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
      const lines = `${stdout}\n${stderr}`
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (lines.length === 0) return null;
      const semanticLines = lines.filter((line) => parseQmdVersion(line) !== null);
      if (semanticLines.length === 0) return lines[0] ?? null;
      return semanticLines.find((line) => /\bqmd\b/i.test(line)) ?? semanticLines[0] ?? null;
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

  private async runQmdCommand(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    return runQmd(args, timeoutMs, this.qmdPath, signal);
  }

  private supportsIntentHints(): boolean {
    return versionAtLeast(parseQmdVersion(this.cliVersion), [1, 1, 5]);
  }

  private supportsExplainTraces(): boolean {
    return versionAtLeast(parseQmdVersion(this.cliVersion), [1, 1, 2]);
  }

  private resolveSearchOptions(options?: SearchQueryOptions): SearchQueryOptions | undefined {
    const normalized = normalizeSearchOptions(options);
    if (!normalized) return undefined;
    const resolved: SearchQueryOptions = {};
    if (normalized.intent && this.supportsIntentHints()) {
      resolved.intent = normalized.intent;
    }
    if (normalized.explain === true && this.supportsExplainTraces()) {
      resolved.explain = true;
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  resolveSupportedSearchOptions(options?: SearchQueryOptions): SearchQueryOptions | undefined {
    return this.resolveSearchOptions(options);
  }

  async search(
    query: string,
    collection?: string,
    maxResults?: number,
    options?: SearchQueryOptions,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    if (!this.isAvailable()) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;
    const searchOptions = this.resolveSearchOptions(options);

    // Try daemon first (bypasses QMD_MUTEX — daemon handles its own concurrency)
    await this.maybeProbeDaemon();
    if (this.daemonAvailable) {
      let results: QmdSearchResult[] | null;
      try {
        results = await this.searchViaDaemon(trimmed, col, n, searchOptions, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          return [];
        }
        throw err;
      }
      if (results !== null) {
        if (results.length > 0) return results;
        // Fail-open: daemon sometimes returns zero hits while subprocess
        // query expansion/rerank still finds relevant docs.
        log.debug("QMD daemon search returned 0 results; falling back to subprocess query");
      }
    }

    // Subprocess fallback
    return this.searchViaSubprocess(trimmed, col, n, searchOptions, execution?.signal);
  }

  async searchGlobal(
    query: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    if (!this.isAvailable()) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const n = maxResults ?? 6;

    // Try daemon first
    await this.maybeProbeDaemon();
    if (this.daemonAvailable) {
      // Global search: no collection filter
      let results: QmdSearchResult[] | null;
      try {
        results = await this.searchViaDaemon(trimmed, undefined, n, undefined, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          return [];
        }
        throw err;
      }
      if (results !== null) {
        if (results.length > 0) return results;
        log.debug("QMD daemon global search returned 0 results; falling back to subprocess query");
      }
    }

    // Subprocess fallback
    return this.searchGlobalViaSubprocess(trimmed, n, execution?.signal);
  }

  /**
   * BM25 keyword search (fast, ~0.3s). Uses `qmd search`.
   */
  async bm25Search(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    if (!this.isAvailable()) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];
    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

    // Try daemon first — BM25 via daemon is much faster than subprocess.
    await this.maybeProbeDaemon();
    if (this.daemonAvailable && this.daemonSession) {
      let results: QmdSearchResult[] | null;
      try {
        results = await this.bm25SearchViaDaemon(trimmed, col, n, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          return [];
        }
        throw err;
      }
      if (results !== null) {
        if (results.length > 0) return results;
        log.debug("QMD daemon bm25 returned 0 results; falling back to subprocess query");
      }
    }
    return this.bm25SearchViaSubprocess(trimmed, col, n, execution?.signal);
  }

  /**
   * Vector similarity search (~3-4s). Uses `qmd vsearch`.
   */
  async vectorSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    if (!this.isAvailable()) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];
    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

    // Try daemon first — keeps models warm, avoids cold subprocess loads.
    await this.maybeProbeDaemon();
    if (this.daemonAvailable && this.daemonSession) {
      let results: QmdSearchResult[] | null;
      try {
        results = await this.vsearchViaDaemon(trimmed, col, n, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          return [];
        }
        throw err;
      }
      if (results !== null) {
        if (results.length > 0) return results;
        log.debug("QMD daemon vsearch returned 0 results; falling back to subprocess query");
      }
    }
    return this.vsearchViaSubprocess(trimmed, col, n, execution?.signal);
  }

  /**
   * Hybrid search: runs BM25 + vector in parallel, merges/dedupes by path
   * keeping the best score and first non-empty snippet.
   */
  async hybridSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    const n = maxResults ?? this.maxResults;
    const trimmed = query.trim();
    if (!trimmed) return [];

    const [bm25Results, vectorResults] = await Promise.all([
      this.bm25Search(trimmed, collection, n, execution),
      this.vectorSearch(trimmed, collection, n, execution),
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
    options?: SearchQueryOptions,
    signal?: AbortSignal,
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
      if (options?.intent) {
        args.intent = options.intent;
      }
      if (options?.explain === true) {
        args.explain = true;
      }

      const result = await this.daemonSession.callTool("query", args, QMD_DAEMON_TIMEOUT_MS, signal);
      const durationMs = Date.now() - startedAtMs;

      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD daemon query: durationMs=${durationMs} collection=${collection ?? "global"} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      const results = parseMcpSearchResult(result, "daemon");

      log.debug(`QMD daemon search: ${results.length} results in ${durationMs}ms`);
      return results;
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (isCallerCancellation(err, signal)) {
        log.debug(`QMD daemon search aborted/cancelled after ${durationMs}ms`);
        throw isAbortError(err) ? err : abortError("QMD daemon search aborted");
      }
      // Timeout: don't invalidate session — daemon is still running, just slow.
      if (isDaemonTimeoutError(err)) {
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
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = Date.now();
    try {
      const result = await this.daemonSession.callTool(
        "search",
        { query, limit: maxResults, collection },
        QMD_DAEMON_TIMEOUT_MS,
        signal,
      );
      const durationMs = Date.now() - startedAtMs;
      const results = parseMcpSearchResult(result);
      log.debug(`QMD daemon bm25: ${results.length} results in ${durationMs}ms`);
      return results;
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (isCallerCancellation(err, signal)) {
        log.debug(`QMD daemon bm25 aborted/cancelled after ${durationMs}ms`);
        throw isAbortError(err) ? err : abortError("QMD daemon bm25 aborted");
      }
      if (isDaemonTimeoutError(err)) {
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
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = Date.now();
    try {
      const result = await this.daemonSession.callTool(
        "vsearch",
        { query, limit: maxResults, collection },
        QMD_DAEMON_TIMEOUT_MS,
        signal,
      );
      const durationMs = Date.now() - startedAtMs;
      const results = parseMcpSearchResult(result);
      log.debug(`QMD daemon vsearch: ${results.length} results in ${durationMs}ms`);
      return results;
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (isCallerCancellation(err, signal)) {
        log.debug(`QMD daemon vsearch aborted/cancelled after ${durationMs}ms`);
        throw isAbortError(err) ? err : abortError("QMD daemon vsearch aborted");
      }
      if (isDaemonTimeoutError(err)) {
        log.debug(`QMD daemon vsearch timed out after ${durationMs}ms, falling back to subprocess`);
        return null;
      }
      log.debug(`QMD daemon vsearch failed after ${durationMs}ms: ${err}`);
      this.daemonSession.invalidate();
      this.daemonAvailable = false;
      return null;
    }
  }

  private async searchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    options?: SearchQueryOptions,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];

    const startedAtMs = Date.now();
    try {
      const args = ["query", query, "-c", collection, "--json", "-n", String(maxResults)];
      if (options?.intent) {
        args.push("--intent", options.intent);
      }
      if (options?.explain === true) {
        args.push("--explain");
      }
      const { stdout } = await runQmd(
        args,
        QMD_TIMEOUT_MS,
        this.qmdPath,
        signal,
      );
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD query: durationMs=${durationMs} collection=${collection} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      return parseQmdSearchStdout(stdout, "subprocess");
    } catch (err) {
      log.debug(`QMD search failed: ${err}`);
      return [];
    }
  }

  private async bm25SearchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["search", query, "-c", collection, "--json", "-n", String(maxResults)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
        signal,
      );
      log.debug(`QMD bm25: ${Date.now() - startedAtMs}ms`);
      return parseQmdSearchStdout(stdout);
    } catch (err) {
      log.debug(`QMD bm25 search failed: ${err}`);
      return [];
    }
  }

  private async vsearchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["vsearch", query, "-c", collection, "--json", "-n", String(maxResults)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
        signal,
      );
      log.debug(`QMD vsearch: ${Date.now() - startedAtMs}ms`);
      return parseQmdSearchStdout(stdout);
    } catch (err) {
      log.debug(`QMD vsearch failed: ${err}`);
      return [];
    }
  }

  private async searchGlobalViaSubprocess(
    query: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];

    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["query", query, "--json", "-n", String(maxResults)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
        signal,
      );
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD global query: durationMs=${durationMs} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      return parseQmdSearchStdout(stdout);
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
      await this.runQmdCommand(["update", "-c", name], this.updateTimeoutMs);
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
      await this.runQmdCommand(["embed", "-c", this.collection], 300_000);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(`SLOW QMD embed: durationMs=${durationMs}`);
      }
      globalState.lastGlobalEmbedRunAtMs = Date.now();
      log.debug("QMD embed completed");
    } catch (err) {
      if (isVectorDimensionMismatchError(err)) {
        try {
          log.warn("QMD embed hit a vector dimension mismatch; retrying with force re-embed");
          await this.runQmdCommand(["embed", "-f"], 300_000);
          globalState.lastGlobalEmbedRunAtMs = Date.now();
          this.lastEmbedFailAtMs = null;
          globalState.lastGlobalEmbedFailAtMs = null;
          log.warn("QMD embed recovered by forcing a full vector rebuild");
          return;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log.warn(`QMD force re-embed failed after dimension mismatch: ${retryMsg}`);
        }
      }
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
      await this.runQmdCommand(["embed", "-c", name], 300_000);
      const at = Date.now();
      globalState.lastEmbedByCollectionMs[name] = at;
      globalState.lastGlobalEmbedRunAtMs = at;
    } catch (err) {
      if (isVectorDimensionMismatchError(err)) {
        try {
          log.warn(`QMD embed for collection ${name} hit a vector dimension mismatch; retrying with force re-embed`);
          await this.runQmdCommand(["embed", "-f"], 300_000);
          const recoveredAt = Date.now();
          globalState.lastEmbedByCollectionMs[name] = recoveredAt;
          globalState.lastGlobalEmbedRunAtMs = recoveredAt;
          delete globalState.lastEmbedFailByCollectionMs[name];
          globalState.lastGlobalEmbedFailAtMs = null;
          log.warn(`QMD embed for collection ${name} recovered by forcing a full vector rebuild`);
          return;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log.warn(`QMD force re-embed failed for collection ${name}: ${retryMsg}`);
        }
      }
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
