/**
 * Memory Boxes + Trace Weaving (v8.0 Phase 2A)
 *
 * Implements the Membox concept: a sliding topic window that forms an "open box"
 * accumulating related memories. The box is sealed on topic shift or time gap,
 * then written to memory/boxes/YYYY-MM-DD/box-<id>.md.
 *
 * Trace Weaving links recurring topic boxes with a shared traceId so that
 * cross-session continuity on the same topics is preserved and discoverable.
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "./logger.js";

export const BOX_DIR = "boxes";
const STATE_DIR = "state";
const TRACES_FILE = "traces.json";
const OPEN_BOX_STATE_FILE = "open-box.json";

// ── Types ─────────────────────────────────────────────────────────────────

export interface BoxFrontmatter {
  id: string;
  memoryKind: "box";
  createdAt: string;
  sealedAt: string;
  sealReason: SealReason;
  sessionKey?: string;
  topics: string[];
  memoryIds: string[];
  traceId?: string;
}

export type SealReason = "topic_shift" | "time_gap" | "max_memories" | "forced" | "flush";

interface OpenBoxState {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  topics: string[];
  memoryIds: string[];
}

interface TraceIndex {
  /** traceId → list of box IDs */
  traces: Record<string, string[]>;
  /** boxId → traceId */
  boxToTrace: Record<string, string>;
  /** traceId → canonical topic fingerprint for matching */
  traceTopics: Record<string, string[]>;
}

export interface BoxBuilderConfig {
  memoryBoxesEnabled: boolean;
  traceWeaverEnabled: boolean;
  /** Jaccard threshold below which topic shift triggers seal (0-1, default 0.35) */
  boxTopicShiftThreshold: number;
  /** Time gap in ms before sealing an open box (default 30 min) */
  boxTimeGapMs: number;
  /** Max memories in one box before forced seal */
  boxMaxMemories: number;
  /** Days back to look for trace links */
  traceWeaverLookbackDays: number;
  /** Minimum topic overlap to assign same traceId (0-1, default 0.4) */
  traceWeaverOverlapThreshold: number;
}

interface ExtractionEvent {
  topics: string[];
  memoryIds: string[];
  timestamp: string;
}

// ── Utility ───────────────────────────────────────────────────────────────

/**
 * Jaccard similarity between two topic arrays.
 * Returns 0.0 for empty inputs.
 */
export function topicOverlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0.0;
  const setA = new Set(a.map((t) => t.toLowerCase()));
  const setB = new Set(b.map((t) => t.toLowerCase()));
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0.0 : intersection / union;
}

function makeBoxId(): string {
  return `box-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeTraceId(topics: string[]): string {
  const key = topics.slice().sort().join(",");
  return `trace-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

// ── Frontmatter serialization ──────────────────────────────────────────────

function serializeBoxFrontmatter(fm: BoxFrontmatter): string {
  const lines = [
    "---",
    `id: ${fm.id}`,
    `memoryKind: ${fm.memoryKind}`,
    `createdAt: ${fm.createdAt}`,
    `sealedAt: ${fm.sealedAt}`,
    `sealReason: ${fm.sealReason}`,
    `topics: [${fm.topics.map((t) => `"${t}"`).join(", ")}]`,
    `memoryIds: [${fm.memoryIds.map((m) => `"${m}"`).join(", ")}]`,
  ];
  if (fm.sessionKey) lines.push(`sessionKey: ${fm.sessionKey}`);
  if (fm.traceId) lines.push(`traceId: ${fm.traceId}`);
  lines.push("---");
  return lines.join("\n");
}

export function parseBoxFrontmatter(raw: string): BoxFrontmatter | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fmBlock = match[1];
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }

  const parseArray = (val: string | undefined): string[] => {
    if (!val) return [];
    const m = val.match(/\[(.*)]/);
    if (!m) return [];
    return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  };

  return {
    id: fm.id ?? "",
    memoryKind: "box",
    createdAt: fm.createdAt ?? "",
    sealedAt: fm.sealedAt ?? "",
    sealReason: (fm.sealReason ?? "forced") as SealReason,
    sessionKey: fm.sessionKey,
    topics: parseArray(fm.topics),
    memoryIds: parseArray(fm.memoryIds),
    traceId: fm.traceId,
  };
}

// ── BoxBuilder ────────────────────────────────────────────────────────────

export class BoxBuilder {
  private baseDir: string;
  private cfg: BoxBuilderConfig;
  private openBox: OpenBoxState | null = null;
  private stateLoaded = false;

  constructor(baseDir: string, cfg: BoxBuilderConfig) {
    this.baseDir = baseDir;
    this.cfg = cfg;
  }

  private get boxBaseDir(): string {
    return path.join(this.baseDir, BOX_DIR);
  }

  private get stateDir(): string {
    return path.join(this.baseDir, STATE_DIR);
  }

  private get openBoxStatePath(): string {
    return path.join(this.stateDir, OPEN_BOX_STATE_FILE);
  }

  private get tracesPath(): string {
    return path.join(this.stateDir, TRACES_FILE);
  }

  // ── State persistence ────────────────────────────────────────────────────

  private async loadOpenBox(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    try {
      const raw = await readFile(this.openBoxStatePath, "utf-8");
      this.openBox = JSON.parse(raw) as OpenBoxState;
    } catch {
      this.openBox = null;
    }
  }

  private async saveOpenBox(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    if (this.openBox) {
      await writeFile(this.openBoxStatePath, JSON.stringify(this.openBox, null, 2), "utf-8");
    } else {
      // Clear open box state
      try { await writeFile(this.openBoxStatePath, "null", "utf-8"); } catch { /* ok */ }
    }
  }

  private async loadTraceIndex(): Promise<TraceIndex> {
    try {
      const raw = await readFile(this.tracesPath, "utf-8");
      return JSON.parse(raw) as TraceIndex;
    } catch {
      return { traces: {}, boxToTrace: {}, traceTopics: {} };
    }
  }

  private async saveTraceIndex(idx: TraceIndex): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.tracesPath, JSON.stringify(idx, null, 2), "utf-8");
  }

  // ── Core logic ────────────────────────────────────────────────────────────

  /**
   * Called after each extraction run.
   * Decides whether to seal the current open box and/or start a new one.
   */
  async onExtraction(event: ExtractionEvent): Promise<void> {
    if (!this.cfg.memoryBoxesEnabled) return;

    await this.loadOpenBox();

    const newTopics = event.topics.filter(Boolean);
    const now = new Date(event.timestamp);
    const nowMs = now.getTime();

    if (this.openBox) {
      // Check seal conditions
      const lastActivity = new Date(this.openBox.lastActivityAt).getTime();
      const timeGapMs = nowMs - lastActivity;
      const overlap = topicOverlapScore(this.openBox.topics, newTopics);
      const topicShifted = newTopics.length > 0 && overlap < (1 - this.cfg.boxTopicShiftThreshold);
      const timeExpired = timeGapMs >= this.cfg.boxTimeGapMs;
      const tooManyMemories =
        this.openBox.memoryIds.length + event.memoryIds.length > this.cfg.boxMaxMemories;

      if (tooManyMemories) {
        // Add current batch then seal
        this.openBox.memoryIds.push(...event.memoryIds);
        await this.sealCurrent("max_memories");
      } else if (topicShifted) {
        await this.sealCurrent("topic_shift");
        this.openBox = this.newBox(event, now.toISOString());
        await this.saveOpenBox();
      } else if (timeExpired) {
        await this.sealCurrent("time_gap");
        this.openBox = this.newBox(event, now.toISOString());
        await this.saveOpenBox();
      } else {
        // Accumulate
        this.openBox.memoryIds.push(...event.memoryIds);
        // Merge new topics (union)
        const topicSet = new Set([...this.openBox.topics, ...newTopics]);
        this.openBox.topics = [...topicSet];
        this.openBox.lastActivityAt = now.toISOString();
        await this.saveOpenBox();
      }
    } else {
      // No open box — start one
      this.openBox = this.newBox(event, now.toISOString());
      // If this initial batch already exceeds max, seal immediately
      if (this.openBox.memoryIds.length > this.cfg.boxMaxMemories) {
        await this.sealCurrent("max_memories");
      } else {
        await this.saveOpenBox();
      }
    }
  }

  private newBox(event: ExtractionEvent, ts: string): OpenBoxState {
    return {
      id: makeBoxId(),
      createdAt: ts,
      lastActivityAt: ts,
      topics: event.topics.filter(Boolean),
      memoryIds: [...event.memoryIds],
    };
  }

  /**
   * Seal the current open box and write it to disk.
   * Also runs trace weaving if enabled.
   */
  async sealCurrent(reason: SealReason): Promise<string | null> {
    await this.loadOpenBox();
    if (!this.openBox) return null;

    const box = this.openBox;
    this.openBox = null;

    if (box.memoryIds.length === 0 && box.topics.length === 0) {
      await this.saveOpenBox();
      return null;
    }

    const sealedAt = new Date().toISOString();
    const day = sealedAt.slice(0, 10);
    const dir = path.join(this.boxBaseDir, day);
    await mkdir(dir, { recursive: true });

    let traceId: string | undefined;
    if (this.cfg.traceWeaverEnabled && box.topics.length > 0) {
      traceId = await this.resolveTrace(box.id, box.topics);
    }

    const fm: BoxFrontmatter = {
      id: box.id,
      memoryKind: "box",
      createdAt: box.createdAt,
      sealedAt,
      sealReason: reason,
      topics: box.topics,
      memoryIds: box.memoryIds,
      traceId,
    };

    const content = `${serializeBoxFrontmatter(fm)}\n\n<!-- Topics: ${box.topics.join(", ")} | Memories: ${box.memoryIds.length} -->\n`;
    const filePath = path.join(dir, `${box.id}.md`);
    await writeFile(filePath, content, "utf-8");
    log.debug(`[boxes] sealed box ${box.id} (${reason}): ${box.memoryIds.length} memories, topics=[${box.topics.join(",")}]`);

    await this.saveOpenBox();
    return box.id;
  }

  // ── Trace Weaving ─────────────────────────────────────────────────────────

  /**
   * Find an existing trace that matches box topics, or create a new trace.
   * Returns the traceId to assign to this box.
   */
  private async resolveTrace(boxId: string, topics: string[]): Promise<string> {
    const idx = await this.loadTraceIndex();

    // Look for existing trace with sufficient topic overlap
    let bestTraceId: string | undefined;
    let bestScore = 0;

    for (const [tid, traceTopics] of Object.entries(idx.traceTopics)) {
      const score = topicOverlapScore(topics, traceTopics);
      if (score >= this.cfg.traceWeaverOverlapThreshold && score > bestScore) {
        bestScore = score;
        bestTraceId = tid;
      }
    }

    const traceId = bestTraceId ?? makeTraceId(topics);

    // Update trace index
    if (!idx.traces[traceId]) idx.traces[traceId] = [];
    idx.traces[traceId].push(boxId);
    idx.boxToTrace[boxId] = traceId;

    // Update canonical topics for this trace (merge)
    if (idx.traceTopics[traceId]) {
      const merged = new Set([...idx.traceTopics[traceId], ...topics]);
      idx.traceTopics[traceId] = [...merged];
    } else {
      idx.traceTopics[traceId] = [...topics];
    }

    await this.saveTraceIndex(idx);
    return traceId;
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  /**
   * Read all sealed boxes from the last N days for recall injection.
   */
  async readRecentBoxes(days: number): Promise<BoxFrontmatter[]> {
    const boxes: BoxFrontmatter[] = [];
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const walkDir = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walkDir(full);
          } else if (e.name.endsWith(".md")) {
            try {
              const raw = await readFile(full, "utf-8");
              const parsed = parseBoxFrontmatter(raw);
              if (parsed && new Date(parsed.sealedAt) >= cutoff) {
                boxes.push(parsed);
              }
            } catch { /* corrupt file — skip */ }
          }
        }
      } catch { /* dir not yet created */ }
    };

    await walkDir(this.boxBaseDir);
    return boxes;
  }
}
