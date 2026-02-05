import { spawn } from "node:child_process";
import { log } from "./logger.js";
import type { QmdSearchResult } from "./types.js";

const QMD_TIMEOUT_MS = 5000;

function runQmd(
  args: string[],
  timeoutMs: number = QMD_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("qmd", args, {
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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `qmd ${args.join(" ")} failed (code ${code}): ${stderr || stdout}`,
          ),
        );
      }
    });
  });
}

export class QmdClient {
  private available: boolean | null = null;

  constructor(
    private readonly collection: string,
    private readonly maxResults: number,
  ) {}

  async probe(): Promise<boolean> {
    try {
      await runQmd(["--version"], 3000);
      this.available = true;
      return true;
    } catch {
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

    try {
      const { stdout } = await runQmd([
        "query",
        trimmed,
        "-c",
        col,
        "--json",
        "-n",
        String(n),
      ]);

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

    try {
      const { stdout } = await runQmd([
        "query",
        trimmed,
        "--json",
        "-n",
        String(n),
      ]);

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
    try {
      await runQmd(["update"], 30_000);
      log.debug("QMD update completed");
    } catch (err) {
      log.warn("QMD update failed", err);
    }
  }

  async embed(): Promise<void> {
    if (this.available === false) return;
    try {
      await runQmd(["embed"], 60_000);
      log.debug("QMD embed completed");
    } catch (err) {
      log.warn("QMD embed failed", err);
    }
  }

  async ensureCollection(memoryDir: string): Promise<boolean> {
    if (this.available === false) return false;
    try {
      const { stdout } = await runQmd(["collection", "list", "--json"]);
      const collections = JSON.parse(stdout);
      if (Array.isArray(collections)) {
        const exists = collections.some(
          (c: Record<string, unknown>) => c.name === this.collection,
        );
        if (exists) return true;
      }
    } catch {
      // collection list command may not support --json, that's fine
    }

    log.info(
      `QMD collection "${this.collection}" not found. ` +
        `Add it to ~/.config/qmd/index.yml pointing at ${memoryDir}`,
    );
    return false;
  }
}
