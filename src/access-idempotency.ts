import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

type AccessIdempotencyEntry = {
  recordedAt: string;
  requestHash: string;
  response: unknown;
};

type AccessIdempotencyTestHooks = {
  beforeFlushWrite?: () => Promise<void> | void;
};

let testHooks: AccessIdempotencyTestHooks | null = null;

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return candidate;
    }
    return Object.keys(candidate)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (candidate as Record<string, unknown>)[key];
        return acc;
      }, {});
  });
}

export function hashAccessIdempotencyPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function setAccessIdempotencyTestHooks(hooks: AccessIdempotencyTestHooks | null): void {
  testHooks = hooks;
}

export class AccessIdempotencyStore {
  private readonly statePath: string;
  private readonly lockPath: string;
  private loadedMtimeMs = 0;
  private state: Record<string, AccessIdempotencyEntry> = {};

  constructor(memoryDir: string) {
    this.statePath = path.join(memoryDir, "state", "access-idempotency.json");
    this.lockPath = `${this.statePath}.lock`;
  }

  async get(key: string, requestHash: string): Promise<{ response?: unknown; conflict: boolean }> {
    await this.reload({ forceRefresh: true });
    const entry = this.state[key];
    if (!entry) return { conflict: false };
    if (entry.requestHash !== requestHash) {
      return { conflict: true };
    }
    return {
      conflict: false,
      response: JSON.parse(JSON.stringify(entry.response)),
    };
  }

  async put(key: string, requestHash: string, response: unknown): Promise<void> {
    await this.reload({ forceRefresh: true });
    this.state[key] = {
      recordedAt: new Date().toISOString(),
      requestHash,
      response: JSON.parse(JSON.stringify(response)),
    };
    await this.prune();
    await this.flush();
  }

  private async reload(options: { forceRefresh?: boolean } = {}): Promise<void> {
    if (options.forceRefresh === true) {
      try {
        const fileStat = await stat(this.statePath);
        if (fileStat.mtimeMs <= this.loadedMtimeMs) {
          return;
        }
      } catch {
        this.state = {};
        this.loadedMtimeMs = 0;
        return;
      }
    }
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, AccessIdempotencyEntry>;
      if (parsed && typeof parsed === "object") {
        this.state = parsed;
        this.loadedMtimeMs = await this.readMtimeMs();
        return;
      }
    } catch {
      // Missing or malformed state should fail open to an empty store.
    }
    this.state = {};
    this.loadedMtimeMs = 0;
  }

  private async prune(): Promise<void> {
    const entries = Object.entries(this.state);
    if (entries.length <= 512) return;
    entries
      .sort((left, right) => right[1].recordedAt.localeCompare(left[1].recordedAt))
      .slice(512)
      .forEach(([key]) => {
        delete this.state[key];
      });
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await this.withFlushLock(async () => {
      try {
        const raw = await readFile(this.statePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, AccessIdempotencyEntry>;
        if (parsed && typeof parsed === "object") {
          this.state = {
            ...parsed,
            ...this.state,
          };
          await this.prune();
        }
      } catch {
        // Fail open when there is no pre-existing shared state to merge.
      }

      await testHooks?.beforeFlushWrite?.();

      const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf-8");
        await rename(tempPath, this.statePath);
      } finally {
        await unlink(tempPath).catch(() => undefined);
      }
      this.loadedMtimeMs = await this.readMtimeMs();
    });
  }

  private async readMtimeMs(): Promise<number> {
    try {
      return (await stat(this.statePath)).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async withFlushLock<T>(callback: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const timeoutMs = 5_000;
    const staleLockMs = 30_000;
    const startedAt = Date.now();

    while (true) {
      try {
        const handle = await open(this.lockPath, "wx");
        try {
          return await callback();
        } finally {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
        }
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > staleLockMs) {
            await unlink(this.lockPath).catch(() => undefined);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error("timed out acquiring access idempotency flush lock");
        }
        await sleep(10);
      }
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
