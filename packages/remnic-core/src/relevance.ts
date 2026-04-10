import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import type { RelevanceFeedback } from "./types.js";

type RelevanceState = Record<string, RelevanceFeedback>;

export class RelevanceStore {
  private readonly statePath: string;
  private state: RelevanceState = {};

  constructor(memoryDir: string) {
    this.statePath = path.join(memoryDir, "state", "relevance.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as RelevanceState;
      if (parsed && typeof parsed === "object") this.state = parsed;
    } catch {
      this.state = {};
    }
  }

  /**
   * Record a thumbs up/down for a memory ID.
   * This is intentionally lightweight; it should never block agent execution.
   */
  async record(memoryId: string, vote: "up" | "down", note?: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.state[memoryId] ?? { up: 0, down: 0, lastUpdatedAt: now };
    const next: RelevanceFeedback = {
      up: existing.up + (vote === "up" ? 1 : 0),
      down: existing.down + (vote === "down" ? 1 : 0),
      lastUpdatedAt: now,
      notes: note
        ? [...(existing.notes ?? []).slice(-19), note]
        : existing.notes,
    };
    this.state[memoryId] = next;

    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      log.debug(`relevance store write failed: ${err}`);
    }
  }

  /**
   * Convert feedback into a small score adjustment.
   * Intended to be used as a tie-breaker/soft bias, not a hard filter.
   */
  adjustment(memoryId: string): number {
    const fb = this.state[memoryId];
    if (!fb) return 0;

    // Cap effect to avoid runaway ranking distortion.
    const up = Math.min(3, fb.up);
    const down = Math.min(3, fb.down);

    // Typical QMD scores are around 0-1; keep adjustments small.
    return up * 0.05 - down * 0.10; // max +0.15, min -0.30
  }
}

