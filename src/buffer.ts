import { log } from "./logger.js";
import { scanSignals } from "./signal.js";
import type { StorageManager } from "./storage.js";
import type {
  BufferState,
  BufferTurn,
  PluginConfig,
  SignalLevel,
} from "./types.js";

export type TriggerDecision = "extract_now" | "extract_batch" | "keep_buffering";

export class SmartBuffer {
  private state: BufferState;
  private loaded = false;

  constructor(
    private readonly config: PluginConfig,
    private readonly storage: StorageManager,
  ) {
    this.state = { turns: [], lastExtractionAt: null, extractionCount: 0 };
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.state = await this.storage.loadBuffer();
    this.loaded = true;
  }

  async save(): Promise<void> {
    await this.storage.saveBuffer(this.state);
  }

  async addTurn(turn: BufferTurn): Promise<TriggerDecision> {
    await this.load();
    this.state.turns.push(turn);

    const signal = scanSignals(turn.content, this.config.highSignalPatterns);
    const decision = this.evaluate(signal.level);

    log.debug(
      `buffer: ${this.state.turns.length} turns, signal=${signal.level}, decision=${decision}`,
    );

    await this.save();
    return decision;
  }

  private evaluate(signalLevel: SignalLevel): TriggerDecision {
    if (this.config.triggerMode === "smart") {
      if (signalLevel === "high") return "extract_now";

      if (this.state.turns.length >= this.config.bufferMaxTurns) {
        return "extract_batch";
      }

      if (this.state.lastExtractionAt) {
        const elapsed =
          Date.now() - new Date(this.state.lastExtractionAt).getTime();
        if (elapsed >= this.config.bufferMaxMinutes * 60_000) {
          return "extract_batch";
        }
      }

      return "keep_buffering";
    }

    if (this.config.triggerMode === "every_n") {
      return this.state.turns.length >= this.config.bufferMaxTurns
        ? "extract_batch"
        : "keep_buffering";
    }

    if (this.config.triggerMode === "time_based") {
      if (!this.state.lastExtractionAt) {
        return this.state.turns.length >= this.config.bufferMaxTurns
          ? "extract_batch"
          : "keep_buffering";
      }
      const elapsed =
        Date.now() - new Date(this.state.lastExtractionAt).getTime();
      return elapsed >= this.config.bufferMaxMinutes * 60_000
        ? "extract_batch"
        : "keep_buffering";
    }

    return "keep_buffering";
  }

  getTurns(): BufferTurn[] {
    return [...this.state.turns];
  }

  async clearAfterExtraction(): Promise<void> {
    this.state.turns = [];
    this.state.lastExtractionAt = new Date().toISOString();
    this.state.extractionCount += 1;
    await this.save();
  }

  getExtractionCount(): number {
    return this.state.extractionCount;
  }
}
