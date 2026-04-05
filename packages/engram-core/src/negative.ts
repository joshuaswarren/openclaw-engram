import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

export interface NegativeExampleEntry {
  notUseful: number;
  lastUpdatedAt: string;
  notes?: string[];
}

type NegativeState = Record<string, NegativeExampleEntry>;

export class NegativeExampleStore {
  private readonly statePath: string;
  private state: NegativeState = {};

  constructor(memoryDir: string) {
    this.statePath = path.join(memoryDir, "state", "negative_examples.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as NegativeState;
      if (parsed && typeof parsed === "object") this.state = parsed;
    } catch {
      this.state = {};
    }
  }

  /**
   * Record that a memory was retrieved but not useful for the user.
   * This should be lightweight and never block agent execution.
   */
  async recordNotUseful(memoryIds: string[], note?: string): Promise<void> {
    const now = new Date().toISOString();

    for (const memoryId of memoryIds) {
      const existing = this.state[memoryId] ?? { notUseful: 0, lastUpdatedAt: now };
      const next: NegativeExampleEntry = {
        notUseful: existing.notUseful + 1,
        lastUpdatedAt: now,
        notes: note
          ? [...(existing.notes ?? []).slice(-19), note]
          : existing.notes,
      };
      this.state[memoryId] = next;
    }

    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      log.debug(`negative example store write failed: ${err}`);
    }
  }

  /**
   * Convert negative examples into a small score penalty.
   * Intended as a soft bias, not a hard filter.
   */
  penalty(memoryId: string, opts: { perHit: number; cap: number }): number {
    const entry = this.state[memoryId];
    if (!entry) return 0;

    // Cap effect to avoid runaway ranking distortion.
    const hits = Math.min(10, entry.notUseful);
    const raw = hits * opts.perHit;
    return Math.min(opts.cap, raw);
  }
}

