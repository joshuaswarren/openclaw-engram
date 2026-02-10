import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "./logger.js";

export interface LastRecallSnapshot {
  sessionKey: string;
  recordedAt: string;
  queryHash: string;
  queryLen: number;
  memoryIds: string[];
}

type LastRecallState = Record<string, LastRecallSnapshot>;

export class LastRecallStore {
  private readonly statePath: string;
  private readonly impressionsPath: string;
  private state: LastRecallState = {};

  constructor(memoryDir: string) {
    this.statePath = path.join(memoryDir, "state", "last_recall.json");
    this.impressionsPath = path.join(memoryDir, "state", "recall_impressions.jsonl");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as LastRecallState;
      if (parsed && typeof parsed === "object") this.state = parsed;
    } catch {
      this.state = {};
    }
  }

  get(sessionKey: string): LastRecallSnapshot | null {
    return this.state[sessionKey] ?? null;
  }

  getMostRecent(): LastRecallSnapshot | null {
    const snapshots = Object.values(this.state);
    if (snapshots.length === 0) return null;
    snapshots.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return snapshots[0] ?? null;
  }

  /**
   * Persist last-recall snapshot and append an impression log entry.
   * Does not store raw query text; uses a stable hash for correlation.
   */
  async record(opts: { sessionKey: string; query: string; memoryIds: string[] }): Promise<void> {
    const now = new Date().toISOString();
    const queryHash = createHash("sha256").update(opts.query).digest("hex");

    const snapshot: LastRecallSnapshot = {
      sessionKey: opts.sessionKey,
      recordedAt: now,
      queryHash,
      queryLen: opts.query.length,
      memoryIds: opts.memoryIds,
    };

    this.state[opts.sessionKey] = snapshot;

    // Keep the state bounded; the impression log is append-only.
    const keys = Object.keys(this.state);
    if (keys.length > 50) {
      const ordered = keys
        .map((k) => ({ k, at: this.state[k]?.recordedAt ?? "" }))
        .sort((a, b) => b.at.localeCompare(a.at));
      for (const doomed of ordered.slice(50)) {
        delete this.state[doomed.k];
      }
    }

    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      log.debug(`last recall store write failed: ${err}`);
    }

    try {
      await mkdir(path.dirname(this.impressionsPath), { recursive: true });
      await appendFile(this.impressionsPath, JSON.stringify(snapshot) + "\n", "utf-8");
    } catch (err) {
      log.debug(`recall impressions append failed: ${err}`);
    }
  }
}
