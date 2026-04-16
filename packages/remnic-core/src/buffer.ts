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

const MAX_BUFFER_ENTRY_COUNT = 200;

export class SmartBuffer {
  private state: BufferState;
  private loaded = false;

  constructor(
    private readonly config: PluginConfig,
    private readonly storage: StorageManager,
  ) {
    this.state = { turns: [], lastExtractionAt: null, extractionCount: 0 };
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
    const decision = this.evaluate(entry, signal.level);

    log.debug(
      `buffer[${bufferKey}]: ${entry.turns.length} turns, signal=${signal.level}, decision=${decision}`,
    );

    this.pruneEntries([bufferKey]);
    await this.save();
    return decision;
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
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return null;
    await this.load();

    const directEntry = this.peekEntry(sessionKey);
    if ((directEntry?.turns.length ?? 0) > 0) {
      return sessionKey;
    }

    const entries = this.state.entries ?? {};
    for (const [bufferKey, entry] of Object.entries(entries)) {
      if (
        entry.turns.some(
          (turn) =>
            typeof turn.sessionKey === "string" && turn.sessionKey === sessionKey,
        )
      ) {
        return bufferKey;
      }
    }

    return null;
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
