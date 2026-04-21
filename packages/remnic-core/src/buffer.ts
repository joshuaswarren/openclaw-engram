import { log } from "./logger.js";
import { scanSignals } from "./signal.js";
import type { StorageManager } from "./storage.js";
import type {
  BufferEntryState,
  BufferState,
  BufferTurn,
  PluginConfig,
  SignalLevel,
} from "./types.js";

export type TriggerDecision = "extract_now" | "extract_batch" | "keep_buffering";

/**
 * Optional surprise probe injected into `SmartBuffer`.
 *
 * Computes a D-MEM-style novelty score in `[0, 1]` for an incoming turn.
 * The buffer treats the probe as purely additive: if it is not provided, if
 * the feature flag is off, or if the probe throws/times out, the buffer
 * falls back to the existing signal/turn-count/time triggers unchanged.
 *
 * Callers are responsible for sampling recent memories and passing them
 * through the embedding pipeline — the buffer does not want to know about
 * storage, embeddings, or QMD.
 *
 * @param bufferKey Identifier for the active buffer (session/thread).
 * @param turn      The incoming turn whose novelty is being scored.
 * @param recentTurns Turns already buffered for this key (most recent first
 *                    is NOT guaranteed — treat as unordered corpus).
 * @returns A surprise score in `[0, 1]`, or `null` if no score could be
 *          produced (e.g. empty corpus, probe declined to embed).
 */
export interface BufferSurpriseProbe {
  scoreTurn(
    bufferKey: string,
    turn: BufferTurn,
    recentTurns: readonly BufferTurn[],
  ): Promise<number | null>;
}

const MAX_BUFFER_ENTRY_COUNT = 200;

export class SmartBuffer {
  private state: BufferState;
  private loaded = false;
  private readonly surpriseProbe: BufferSurpriseProbe | null;

  constructor(
    private readonly config: PluginConfig,
    private readonly storage: StorageManager,
    surpriseProbe: BufferSurpriseProbe | null = null,
  ) {
    this.state = { turns: [], lastExtractionAt: null, extractionCount: 0 };
    this.surpriseProbe = surpriseProbe;
  }

  private entryFor(key: string): BufferEntryState {
    this.state.entries ??= {};
    const existing = this.state.entries[key];
    if (existing) return existing;
    const created: BufferEntryState = {
      turns: [],
      lastExtractionAt: null,
      extractionCount: 0,
    };
    this.state.entries[key] = created;
    return created;
  }

  private peekEntry(key: string): BufferEntryState | null {
    const existing = this.state.entries?.[key];
    if (existing) return existing;
    if (key !== "default") return null;
    return {
      turns: Array.isArray(this.state.turns) ? this.state.turns : [],
      lastExtractionAt: this.state.lastExtractionAt ?? null,
      extractionCount:
        typeof this.state.extractionCount === "number" ? this.state.extractionCount : 0,
    };
  }

  private normalizeState(state: BufferState): BufferState {
    const entries = state.entries ?? {};
    if (!entries.default) {
      entries.default = {
        turns: Array.isArray(state.turns) ? [...state.turns] : [],
        lastExtractionAt: state.lastExtractionAt ?? null,
        extractionCount:
          typeof state.extractionCount === "number" ? state.extractionCount : 0,
      };
    }
    return {
      turns: entries.default.turns,
      lastExtractionAt: entries.default.lastExtractionAt,
      extractionCount: entries.default.extractionCount,
      entries,
    };
  }

  private entryActivityAt(entry: BufferEntryState): number {
    const lastTurnAt = entry.turns.reduce((latest, turn) => {
      const parsed = Date.parse(turn.timestamp);
      return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
    }, -1);
    const lastExtractionAt =
      typeof entry.lastExtractionAt === "string"
        ? Date.parse(entry.lastExtractionAt)
        : Number.NaN;
    return Math.max(
      lastTurnAt,
      Number.isFinite(lastExtractionAt) ? lastExtractionAt : -1,
    );
  }

  private pruneEntries(retainKeys: string[]): void {
    const entries = this.state.entries;
    if (!entries) return;
    const keys = Object.keys(entries);
    if (keys.length <= MAX_BUFFER_ENTRY_COUNT) return;

    const insertionOrder = new Map(keys.map((key, index) => [key, index]));
    const removable = keys
      .filter((key) => key !== "default" && !retainKeys.includes(key))
      .filter((key) => (entries[key]?.turns.length ?? 0) === 0)
      .sort((left, right) => {
        const leftAt = this.entryActivityAt(entries[left] ?? {
          turns: [],
          lastExtractionAt: null,
          extractionCount: 0,
        });
        const rightAt = this.entryActivityAt(entries[right] ?? {
          turns: [],
          lastExtractionAt: null,
          extractionCount: 0,
        });
        if (leftAt !== rightAt) return leftAt - rightAt;
        return (insertionOrder.get(left) ?? 0) - (insertionOrder.get(right) ?? 0);
      });

    const removableCount = Math.max(0, keys.length - MAX_BUFFER_ENTRY_COUNT);
    for (const key of removable.slice(0, removableCount)) {
      delete entries[key];
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.state = this.normalizeState(await this.storage.loadBuffer());
    this.loaded = true;
  }

  /**
   * Reset the buffer to an empty, usable state.
   * Called when the persisted buffer file is corrupt and load() fails,
   * so the buffer can still accept new turns for the rest of the session.
   */
  resetToEmpty(): void {
    this.state = { turns: [], lastExtractionAt: null, extractionCount: 0 };
    this.loaded = true;
  }

  async save(): Promise<void> {
    await this.storage.saveBuffer(this.state);
  }

  async addTurn(bufferKey: string, turn: BufferTurn): Promise<TriggerDecision> {
    await this.load();
    const entry = this.entryFor(bufferKey);
    entry.turns.push(turn);
    if (bufferKey === "default") {
      this.state.turns = entry.turns;
    }

    const signal = scanSignals(turn.content, this.config.highSignalPatterns);
    let decision = this.evaluate(entry, signal.level);

    // Surprise-gated flush (issue #563). Additive only: if the probe is
    // disabled, unavailable, or the score is below threshold, the decision
    // from the existing trigger logic stands. The probe only ever *promotes*
    // `keep_buffering` → `extract_now`; it never suppresses an existing
    // flush. This preserves the invariant that enabling surprise cannot
    // *reduce* extraction frequency.
    if (
      decision === "keep_buffering" &&
      this.config.bufferSurpriseTriggerEnabled &&
      this.surpriseProbe !== null &&
      // Matching the existing "smart" branch: surprise is a lower-tier
      // novelty signal that should not second-guess a high-signal hit
      // (which already flushes) or fight `every_n` / `time_based` modes.
      this.config.triggerMode === "smart" &&
      signal.level !== "high"
    ) {
      const surprise = await this.computeSurpriseSafe(bufferKey, turn, entry);
      if (
        surprise !== null &&
        surprise > this.config.bufferSurpriseThreshold
      ) {
        log.debug(
          `buffer[${bufferKey}]: surprise=${surprise.toFixed(3)} > threshold=${this.config.bufferSurpriseThreshold} → extract_now`,
        );
        decision = "extract_now";
      }
    }

    log.debug(
      `buffer[${bufferKey}]: ${entry.turns.length} turns, signal=${signal.level}, decision=${decision}`,
    );

    this.pruneEntries([bufferKey]);
    await this.save();
    return decision;
  }

  /**
   * Invoke the injected surprise probe defensively. Any error (probe throws,
   * embedder unavailable, timeout) is swallowed and logged at debug: the
   * surprise path must never crash the happy-path trigger evaluation. A
   * `null` return indicates "no score available, fall through to existing
   * triggers".
   */
  private async computeSurpriseSafe(
    bufferKey: string,
    turn: BufferTurn,
    entry: BufferEntryState,
  ): Promise<number | null> {
    if (!this.surpriseProbe) return null;
    // The current turn was just pushed into entry.turns; exclude it from the
    // corpus so the probe never compares a turn to itself.
    const prior = entry.turns.length > 0
      ? entry.turns.slice(0, -1)
      : [];
    try {
      const score = await this.surpriseProbe.scoreTurn(bufferKey, turn, prior);
      if (score === null) return null;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        log.debug(
          `buffer[${bufferKey}]: surprise probe returned non-finite score (${String(score)}), ignoring`,
        );
        return null;
      }
      // Defensive clamp: formula lives in buffer-surprise.ts, but we never
      // want a misbehaving probe to inject an out-of-range value into the
      // threshold comparison.
      if (score < 0) return 0;
      if (score > 1) return 1;
      return score;
    } catch (err) {
      log.debug(
        `buffer[${bufferKey}]: surprise probe failed, falling back to existing triggers: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private evaluate(entry: BufferEntryState, signalLevel: SignalLevel): TriggerDecision {
    if (this.config.triggerMode === "smart") {
      if (signalLevel === "high") return "extract_now";

      if (entry.turns.length >= this.config.bufferMaxTurns) {
        return "extract_batch";
      }

      if (entry.lastExtractionAt) {
        const elapsed =
          Date.now() - new Date(entry.lastExtractionAt).getTime();
        if (elapsed >= this.config.bufferMaxMinutes * 60_000) {
          return "extract_batch";
        }
      }

      return "keep_buffering";
    }

    if (this.config.triggerMode === "every_n") {
      return entry.turns.length >= this.config.bufferMaxTurns
        ? "extract_batch"
        : "keep_buffering";
    }

    if (this.config.triggerMode === "time_based") {
      if (!entry.lastExtractionAt) {
        return entry.turns.length >= this.config.bufferMaxTurns
          ? "extract_batch"
          : "keep_buffering";
      }
      const elapsed =
        Date.now() - new Date(entry.lastExtractionAt).getTime();
      return elapsed >= this.config.bufferMaxMinutes * 60_000
        ? "extract_batch"
        : "keep_buffering";
    }

    return "keep_buffering";
  }

  getTurns(bufferKey = "default"): BufferTurn[] {
    const entry = this.peekEntry(bufferKey);
    if (!entry) return [];
    return [...entry.turns];
  }

  async findBufferKeyForSession(sessionKey: string): Promise<string | null> {
    const bufferKeys = await this.findBufferKeysForSession(sessionKey);
    return bufferKeys[0] ?? null;
  }

  async findBufferKeysForSession(sessionKey: string): Promise<string[]> {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return [];
    await this.load();

    const matches: string[] = [];
    const directEntry = this.peekEntry(sessionKey);
    if ((directEntry?.turns.length ?? 0) > 0) {
      matches.push(sessionKey);
    }

    const entries = this.state.entries ?? {};
    for (const [bufferKey, entry] of Object.entries(entries)) {
      if (
        !matches.includes(bufferKey) &&
        entry.turns.some(
          (turn) =>
            typeof turn.sessionKey === "string" && turn.sessionKey === sessionKey,
        )
      ) {
        matches.push(bufferKey);
      }
    }

    return matches;
  }

  async clearAfterExtraction(bufferKey = "default"): Promise<void> {
    await this.load();
    const entry = this.entryFor(bufferKey);
    entry.turns = [];
    entry.lastExtractionAt = new Date().toISOString();
    entry.extractionCount += 1;
    if (bufferKey === "default") {
      this.state.turns = entry.turns;
      this.state.lastExtractionAt = entry.lastExtractionAt;
      this.state.extractionCount = entry.extractionCount;
    }
    this.pruneEntries([bufferKey]);
    await this.save();
  }

  getExtractionCount(bufferKey = "default"): number {
    return this.peekEntry(bufferKey)?.extractionCount ?? 0;
  }
}
