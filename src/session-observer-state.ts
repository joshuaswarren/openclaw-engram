import path from "node:path";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { log } from "./logger.js";
import type { SessionObserverBandConfig } from "./types.js";
import { cloneDefaultSessionObserverBands } from "./session-observer-bands.js";

interface SessionObserverCursor {
  sessionKey: string;
  cursorBytes: number;
  cursorTokens: number;
  lastObservedAt: string;
  lastTriggeredAt?: string;
}

interface SessionObserverPersistedState {
  version: 1;
  sessions: Record<string, SessionObserverCursor>;
}

export interface SessionObservationInput {
  sessionKey: string;
  totalBytes: number;
  totalTokens: number;
  observedAt?: string;
}

export interface SessionObservationDecision {
  triggered: boolean;
  deltaBytes: number;
  deltaTokens: number;
  band: SessionObserverBandConfig;
  reason?: "threshold" | "debounced" | "baseline";
}

function sanitizeNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function parseIsoMs(value?: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function normalizeObserverBands(
  bands: SessionObserverBandConfig[],
): SessionObserverBandConfig[] {
  const normalized = bands
    .map((band) => ({
      maxBytes: sanitizeNonNegativeInt(band.maxBytes),
      triggerDeltaBytes: sanitizeNonNegativeInt(band.triggerDeltaBytes),
      triggerDeltaTokens: sanitizeNonNegativeInt(band.triggerDeltaTokens),
    }))
    .filter((band) => band.maxBytes > 0)
    .sort((a, b) => a.maxBytes - b.maxBytes);

  if (normalized.length === 0) {
    return cloneDefaultSessionObserverBands();
  }

  const last = normalized[normalized.length - 1];
  if (last && last.maxBytes < 1_000_000_000) {
    normalized.push({
      maxBytes: 1_000_000_000,
      triggerDeltaBytes: last.triggerDeltaBytes,
      triggerDeltaTokens: last.triggerDeltaTokens,
    });
  }
  return normalized;
}

export class SessionObserverState {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly debounceMs: number;
  private readonly bands: SessionObserverBandConfig[];
  private sessions = new Map<string, SessionObserverCursor>();
  private saveQueue: Promise<void> = Promise.resolve();

  private async readPersistedState(): Promise<SessionObserverPersistedState | null> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as SessionObserverPersistedState;
      if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private normalizePersistedSessions(
    sessions: Record<string, SessionObserverCursor>,
  ): Map<string, SessionObserverCursor> {
    const next = new Map<string, SessionObserverCursor>();
    for (const [sessionKey, value] of Object.entries(sessions)) {
      if (!value || typeof value !== "object") continue;
      next.set(sessionKey, {
        sessionKey,
        cursorBytes: sanitizeNonNegativeInt(value.cursorBytes),
        cursorTokens: sanitizeNonNegativeInt(value.cursorTokens),
        lastObservedAt:
          typeof value.lastObservedAt === "string" ? value.lastObservedAt : new Date(0).toISOString(),
        lastTriggeredAt: typeof value.lastTriggeredAt === "string" ? value.lastTriggeredAt : undefined,
      });
    }
    return next;
  }

  constructor(opts: {
    memoryDir: string;
    debounceMs: number;
    bands: SessionObserverBandConfig[];
  }) {
    this.statePath = path.join(opts.memoryDir, "state", "session-observer-state.json");
    this.lockPath = path.join(opts.memoryDir, "state", "session-observer-state.lock");
    this.debounceMs = Math.max(0, Math.floor(opts.debounceMs));
    this.bands = normalizeObserverBands(opts.bands);
  }

  private async withSaveLock(fn: () => Promise<void>): Promise<void> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const handle = await open(this.lockPath, "wx");
        try {
          await fn();
        } finally {
          await handle.close();
          await unlink(this.lockPath).catch(() => {});
        }
        return;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    log.debug("session observer save lock timeout");
  }

  async load(): Promise<void> {
    const parsed = await this.readPersistedState();
    if (!parsed) {
      this.sessions.clear();
      return;
    }
    this.sessions = this.normalizePersistedSessions(parsed.sessions);
  }

  async save(): Promise<void> {
    try {
      await this.withSaveLock(async () => {
        const merged = new Map<string, SessionObserverCursor>();
        const persisted = await this.readPersistedState();
        if (persisted) {
          for (const [key, value] of this.normalizePersistedSessions(persisted.sessions).entries()) {
            merged.set(key, value);
          }
        }
        for (const [key, current] of this.sessions.entries()) {
          const existing = merged.get(key);
          if (!existing) {
            merged.set(key, current);
            continue;
          }
          const currentObserved = parseIsoMs(current.lastObservedAt);
          const existingObserved = parseIsoMs(existing.lastObservedAt);
          if (currentObserved > existingObserved) {
            merged.set(key, current);
            continue;
          }
          if (currentObserved < existingObserved) {
            continue;
          }
          const currentTriggered = parseIsoMs(current.lastTriggeredAt);
          const existingTriggered = parseIsoMs(existing.lastTriggeredAt);
          if (currentTriggered >= existingTriggered) {
            merged.set(key, current);
          }
        }
        this.sessions = merged;

        const sessions: Record<string, SessionObserverCursor> = {};
        for (const [key, value] of merged.entries()) {
          sessions[key] = value;
        }
        const payload: SessionObserverPersistedState = { version: 1, sessions };
        await mkdir(path.dirname(this.statePath), { recursive: true });
        await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf-8");
      });
    } catch (err) {
      log.debug(`session observer state write failed: ${err}`);
    }
  }

  private enqueueSave(): Promise<void> {
    this.saveQueue = this.saveQueue.then(() => this.save());
    return this.saveQueue;
  }

  private bandForTotalBytes(totalBytes: number): SessionObserverBandConfig {
    const bytes = sanitizeNonNegativeInt(totalBytes);
    for (const band of this.bands) {
      if (bytes <= band.maxBytes) return band;
    }
    return this.bands[this.bands.length - 1];
  }

  async observe(input: SessionObservationInput): Promise<SessionObservationDecision> {
    const nowIso = input.observedAt ?? new Date().toISOString();
    const totalBytes = sanitizeNonNegativeInt(input.totalBytes);
    const totalTokens = sanitizeNonNegativeInt(input.totalTokens);
    const band = this.bandForTotalBytes(totalBytes);

    const existing = this.sessions.get(input.sessionKey);
    if (!existing) {
      this.sessions.set(input.sessionKey, {
        sessionKey: input.sessionKey,
        cursorBytes: totalBytes,
        cursorTokens: totalTokens,
        lastObservedAt: nowIso,
      });
      await this.enqueueSave();
      return {
        triggered: false,
        deltaBytes: 0,
        deltaTokens: 0,
        band,
        reason: "baseline",
      };
    }

    const session = { ...existing };
    if (totalBytes < session.cursorBytes || totalTokens < session.cursorTokens) {
      session.cursorBytes = totalBytes;
      session.cursorTokens = totalTokens;
      session.lastObservedAt = nowIso;
      this.sessions.set(input.sessionKey, session);
      await this.enqueueSave();
      return { triggered: false, deltaBytes: 0, deltaTokens: 0, band, reason: "baseline" };
    }

    const deltaBytes = totalBytes - session.cursorBytes;
    const deltaTokens = totalTokens - session.cursorTokens;
    const crossedThreshold =
      (band.triggerDeltaBytes > 0 && deltaBytes >= band.triggerDeltaBytes)
      || (band.triggerDeltaTokens > 0 && deltaTokens >= band.triggerDeltaTokens);
    session.lastObservedAt = nowIso;

    if (!crossedThreshold) {
      this.sessions.set(input.sessionKey, session);
      await this.enqueueSave();
      return {
        triggered: false,
        deltaBytes,
        deltaTokens,
        band,
      };
    }

    const nowMs = Date.parse(nowIso);
    const lastTriggeredMs = session.lastTriggeredAt ? Date.parse(session.lastTriggeredAt) : NaN;
    const withinDebounce =
      Number.isFinite(lastTriggeredMs) && nowMs - lastTriggeredMs < this.debounceMs;

    if (withinDebounce) {
      this.sessions.set(input.sessionKey, session);
      await this.enqueueSave();
      return {
        triggered: false,
        deltaBytes,
        deltaTokens,
        band,
        reason: "debounced",
      };
    }

    session.lastTriggeredAt = nowIso;
    session.cursorBytes = totalBytes;
    session.cursorTokens = totalTokens;
    this.sessions.set(input.sessionKey, session);
    await this.enqueueSave();
    return {
      triggered: true,
      deltaBytes,
      deltaTokens,
      band,
      reason: "threshold",
    };
  }
}
