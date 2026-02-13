import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.js";
import type { QmdSearchResult } from "./types.js";

const QMD_TIMEOUT_MS = 30_000;
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

export class QmdClient {
  private available: boolean | null = null;
  private lastUpdateFailAtMs: number | null = null;
  private lastEmbedFailAtMs: number | null = null;
  private readonly updateTimeoutMs: number;
  private readonly slowLog?: { enabled: boolean; thresholdMs: number };

  constructor(
    private readonly collection: string,
    private readonly maxResults: number,
    opts?: {
      slowLog?: { enabled: boolean; thresholdMs: number };
      updateTimeoutMs?: number;
    },
  ) {
    this.slowLog = opts?.slowLog;
    this.updateTimeoutMs = opts?.updateTimeoutMs ?? 120_000;
  }

  private qmdPath: string = "qmd";

  async probe(): Promise<boolean> {
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

  isAvailable(): boolean {
    return this.available === true;
  }

  async search(
    query: string,
    collection?: string,
    maxResults?: number,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["query", trimmed, "-c", col, "--json", "-n", String(n)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD query: durationMs=${durationMs} collection=${col} maxResults=${n} queryChars=${trimmed.length}`,
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

  async searchGlobal(
    query: string,
    maxResults?: number,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const n = maxResults ?? 6;

    const startedAtMs = Date.now();
    try {
      const { stdout } = await runQmd(
        ["query", trimmed, "--json", "-n", String(n)],
        QMD_TIMEOUT_MS,
        this.qmdPath,
      );
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD global query: durationMs=${durationMs} maxResults=${n} queryChars=${trimmed.length}`,
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
    if (this.available === false) return false;
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
