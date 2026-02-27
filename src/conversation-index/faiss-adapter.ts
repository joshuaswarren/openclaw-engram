import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { log } from "../logger.js";
import type { ConversationChunk } from "./chunker.js";
import type { ConversationSearchResult } from "./search.js";

export interface FaissAdapterConfig {
  memoryDir: string;
  scriptPath?: string;
  pythonBin?: string;
  modelId: string;
  indexDir: string;
  upsertTimeoutMs: number;
  searchTimeoutMs: number;
  healthTimeoutMs: number;
  maxBatchSize: number;
  maxSearchK: number;
  spawnFn?: typeof childProcess.spawn;
}

export interface FaissHealthResult {
  ok: boolean;
  status: "ok" | "degraded" | "error";
  indexPath: string;
  message?: string;
}

type SidecarCommand = "upsert" | "search" | "health";

export class FaissAdapterError extends Error {
  constructor(message: string, readonly code: "timeout" | "non_zero_exit" | "malformed_output") {
    super(message);
    this.name = "FaissAdapterError";
  }
}

interface SidecarResult {
  ok?: boolean;
  error?: string;
  upserted?: number;
  status?: "ok" | "degraded" | "error";
  results?: Array<{
    path: string;
    snippet: string;
    score: number;
  }>;
}

export function resolveDefaultFaissScriptPath(fromModuleUrl: string = import.meta.url): string {
  const currentFile = fileURLToPath(fromModuleUrl);
  const moduleDir = path.dirname(currentFile);

  // Source runtime: src/conversation-index/faiss-adapter.ts
  if (moduleDir.endsWith(`${path.sep}conversation-index`)) {
    return path.resolve(moduleDir, "..", "..", "scripts", "faiss_index.py");
  }

  // Bundled runtime: dist/index.js (or neighboring dist chunks)
  return path.resolve(moduleDir, "..", "scripts", "faiss_index.py");
}

export class FaissConversationIndexAdapter {
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly indexPath: string;
  private readonly spawnFn: typeof childProcess.spawn;

  constructor(private readonly config: FaissAdapterConfig) {
    this.pythonBin = config.pythonBin && config.pythonBin.trim().length > 0 ? config.pythonBin.trim() : "python3";
    this.scriptPath = config.scriptPath && config.scriptPath.trim().length > 0
      ? config.scriptPath.trim()
      : resolveDefaultFaissScriptPath();
    this.indexPath = path.isAbsolute(config.indexDir)
      ? config.indexDir
      : path.join(config.memoryDir, config.indexDir);
    this.spawnFn = config.spawnFn ?? childProcess.spawn;
  }

  async upsertChunks(chunks: ConversationChunk[]): Promise<number> {
    if (this.config.maxBatchSize <= 0) return 0;
    let totalUpserted = 0;
    for (let offset = 0; offset < chunks.length; offset += this.config.maxBatchSize) {
      const batch = chunks.slice(offset, offset + this.config.maxBatchSize);
      if (batch.length === 0) continue;
      const payload = {
        modelId: this.config.modelId,
        indexPath: this.indexPath,
        chunks: batch.map((chunk) => ({
          id: chunk.id,
          sessionKey: chunk.sessionKey,
          text: chunk.text,
          startTs: chunk.startTs,
          endTs: chunk.endTs,
        })),
      };
      const result = await this.runCommand("upsert", payload, this.config.upsertTimeoutMs);
      const upserted = result.upserted;
      if (typeof upserted !== "number" || !Number.isFinite(upserted)) {
        throw new FaissAdapterError("FAISS sidecar produced malformed upsert response", "malformed_output");
      }
      totalUpserted += Math.max(0, Math.floor(upserted));
    }
    return totalUpserted;
  }

  async searchChunks(query: string, topK: number): Promise<ConversationSearchResult[]> {
    const boundedTopK = this.config.maxSearchK > 0
      ? Math.max(0, Math.min(Math.floor(topK), this.config.maxSearchK))
      : 0;
    if (boundedTopK <= 0 || query.trim().length === 0) return [];
    const payload = {
      modelId: this.config.modelId,
      indexPath: this.indexPath,
      query,
      topK: boundedTopK,
    };
    const result = await this.runCommand("search", payload, this.config.searchTimeoutMs);
    if (!Array.isArray(result.results)) {
      throw new FaissAdapterError("FAISS sidecar produced malformed search response", "malformed_output");
    }
    const rows = result.results;
    return rows
      .filter((row) =>
        row &&
        typeof row.path === "string" &&
        typeof row.snippet === "string" &&
        typeof row.score === "number"
      )
      .map((row) => ({ path: row.path, snippet: row.snippet, score: row.score }));
  }

  async health(): Promise<FaissHealthResult> {
    const payload = {
      modelId: this.config.modelId,
      indexPath: this.indexPath,
    };
    const result = await this.runCommand("health", payload, this.config.healthTimeoutMs);
    if (result.status !== "ok" && result.status !== "degraded" && result.status !== "error") {
      throw new FaissAdapterError("FAISS sidecar produced malformed health response", "malformed_output");
    }
    return {
      ok: result.ok === true,
      status: result.status,
      indexPath: this.indexPath,
      message: typeof result.error === "string" && result.error.length > 0 ? result.error : undefined,
    };
  }

  private async runCommand(command: SidecarCommand, payload: object, timeoutMs: number): Promise<SidecarResult> {
    const args = [this.scriptPath, command];
    const child = this.spawnFn(this.pythonBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    let code: number | null;
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();

      code = await new Promise<number | null>((resolve, reject) => {
        const rejectAsProcessError = (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          reject(new FaissAdapterError(`FAISS sidecar stream/process error (${command}): ${msg}`, "non_zero_exit"));
        };
        child.once("error", rejectAsProcessError);
        child.stdin.once("error", rejectAsProcessError);
        child.once("close", (exitCode) => resolve(exitCode));
      });
    } catch (err) {
      if (err instanceof FaissAdapterError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new FaissAdapterError(`FAISS sidecar stream/process error (${command}): ${msg}`, "non_zero_exit");
    } finally {
      if (timer) clearTimeout(timer);
    }

    const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

    if (timedOut) {
      throw new FaissAdapterError(
        `FAISS sidecar command timed out (${command}, ${timeoutMs}ms)`,
        "timeout",
      );
    }
    if (code !== 0) {
      throw new FaissAdapterError(
        `FAISS sidecar exited non-zero (${command}, code=${code ?? "null"})${stderr ? `: ${stderr}` : ""}`,
        "non_zero_exit",
      );
    }
    if (stdout.length === 0) {
      throw new FaissAdapterError(
        `FAISS sidecar produced empty output (${command})`,
        "malformed_output",
      );
    }

    let parsed: SidecarResult;
    try {
      parsed = JSON.parse(stdout) as SidecarResult;
    } catch {
      throw new FaissAdapterError(
        `FAISS sidecar produced malformed JSON (${command})`,
        "malformed_output",
      );
    }

    if (parsed.ok === false) {
      const message = typeof parsed.error === "string" && parsed.error.length > 0
        ? parsed.error
        : `FAISS sidecar command failed (${command})`;
      throw new FaissAdapterError(message, "non_zero_exit");
    }
    if (parsed.ok !== true) {
      throw new FaissAdapterError(
        `FAISS sidecar produced malformed success envelope (${command})`,
        "malformed_output",
      );
    }

    return parsed;
  }
}

export async function failOpenFaissHealth(
  adapter: FaissConversationIndexAdapter | undefined,
): Promise<FaissHealthResult> {
  if (!adapter) {
    return { ok: false, status: "error", indexPath: "", message: "adapter-unavailable" };
  }
  try {
    return await adapter.health();
  } catch (err) {
    log.debug(`faiss adapter health failed (fail-open): ${err}`);
    return { ok: false, status: "error", indexPath: "", message: "adapter-error" };
  }
}
