import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { log } from "./logger.js";
import type { SessionObserverBandConfig } from "./types.js";

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
    return [
      { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
      { maxBytes: 200_000, triggerDeltaBytes: 12_000, triggerDeltaTokens: 2_400 },
      { maxBytes: 1_000_000_000, triggerDeltaBytes: 24_000, triggerDeltaTokens: 4_800 },
    ];
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
  private readonly debounceMs: number;
  private readonly bands: SessionObserverBandConfig[];
  private sessions = new Map<string, SessionObserverCursor>();

  constructor(opts: {
    memoryDir: string;
    debounceMs: number;
    bands: SessionObserverBandConfig[];
  }) {
    this.statePath = path.join(opts.memoryDir, "state", "session-observer-state.json");
    this.debounceMs = Math.max(0, Math.floor(opts.debounceMs));
    this.bands = normalizeObserverBands(opts.bands);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as SessionObserverPersistedState;
      if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
        this.sessions.clear();
        return;
      }

      const next = new Map<string, SessionObserverCursor>();
      for (const [sessionKey, value] of Object.entries(parsed.sessions)) {
        if (!value || typeof value !== "object") continue;
        next.set(sessionKey, {
          sessionKey,
          cursorBytes: sanitizeNonNegativeInt(value.cursorBytes),
          cursorTokens: sanitizeNonNegativeInt(value.cursorTokens),
          lastObservedAt: typeof value.lastObservedAt === "string" ? value.lastObservedAt : new Date(0).toISOString(),
          lastTriggeredAt: typeof value.lastTriggeredAt === "string" ? value.lastTriggeredAt : undefined,
        });
      }
      this.sessions = next;
    } catch {
      this.sessions.clear();
    }
  }

  async save(): Promise<void> {
    const sessions: Record<string, SessionObserverCursor> = {};
    for (const [key, value] of this.sessions.entries()) {
      sessions[key] = value;
    }
    const payload: SessionObserverPersistedState = { version: 1, sessions };
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log.debug(`session observer state write failed: ${err}`);
    }
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
      await this.save();
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
      await this.save();
      return { triggered: false, deltaBytes: 0, deltaTokens: 0, band, reason: "baseline" };
    }

    const deltaBytes = totalBytes - session.cursorBytes;
    const deltaTokens = totalTokens - session.cursorTokens;
    const crossedThreshold =
      deltaBytes >= band.triggerDeltaBytes || deltaTokens >= band.triggerDeltaTokens;
    session.lastObservedAt = nowIso;

    if (!crossedThreshold) {
      this.sessions.set(input.sessionKey, session);
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
    await this.save();
    return {
      triggered: true,
      deltaBytes,
      deltaTokens,
      band,
      reason: "threshold",
    };
  }
}
