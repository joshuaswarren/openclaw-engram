import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

type AccessIdempotencyEntry = {
  recordedAt: string;
  requestHash: string;
  response: unknown;
};

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

export class AccessIdempotencyStore {
  private readonly statePath: string;
  private loadedMtimeMs = 0;
  private state: Record<string, AccessIdempotencyEntry> = {};

  constructor(memoryDir: string) {
    this.statePath = path.join(memoryDir, "state", "access-idempotency.json");
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
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    this.loadedMtimeMs = await this.readMtimeMs();
  }

  private async readMtimeMs(): Promise<number> {
    try {
      return (await stat(this.statePath)).mtimeMs;
    } catch {
      return 0;
    }
  }
}
