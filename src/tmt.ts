/**
 * Temporal Memory Tree (TiMem-inspired, v8.2)
 *
 * Builds a hierarchy of summarised memory nodes:
 *   hour-HH.md → day.md → week-YYYY-WW.md → persona.md
 *
 * Stored under `<baseDir>/tmt/`.
 * All writes are fail-open: errors are caught and logged, never thrown.
 */

import * as fs from "fs";
import * as path from "path";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";

export const TMT_DIR = "tmt";

export type TmtLevel = "hour" | "day" | "week" | "persona";

export interface TmtNodeFrontmatter {
  level: TmtLevel;
  periodStart: string; // ISO date-time
  periodEnd: string;   // ISO date-time
  memoryCount: number;
  sourceIds: string[];
  builtAt: string;     // ISO date-time
}

export interface TmtNode {
  frontmatter: TmtNodeFrontmatter;
  summary: string;
  filePath: string;
}

export interface TmtConfig {
  temporalMemoryTreeEnabled: boolean;
  tmtHourlyMinMemories: number;   // default 3
  tmtSummaryMaxTokens: number;    // default 300
}

export interface MemoryEntry {
  path: string;
  id: string;
  created: string; // ISO date-time
  content: string;
}

// ── Path helpers ────────────────────────────────────────────────────────────

export function tmtDir(baseDir: string): string {
  return path.join(baseDir, TMT_DIR);
}

export function hourNodePath(baseDir: string, date: string, hour: string): string {
  return path.join(tmtDir(baseDir), date, `hour-${hour}.md`);
}

export function dayNodePath(baseDir: string, date: string): string {
  return path.join(tmtDir(baseDir), date, "day.md");
}

export function weekNodePath(baseDir: string, weekKey: string): string {
  return path.join(tmtDir(baseDir), `week-${weekKey}.md`);
}

export function personaNodePath(baseDir: string): string {
  return path.join(tmtDir(baseDir), "persona.md");
}

// ── Frontmatter helpers ─────────────────────────────────────────────────────

export function serialiseTmtNode(fm: TmtNodeFrontmatter, summary: string): string {
  const yaml = [
    "---",
    `level: ${fm.level}`,
    `periodStart: "${fm.periodStart}"`,
    `periodEnd: "${fm.periodEnd}"`,
    `memoryCount: ${fm.memoryCount}`,
    `sourceIds: [${fm.sourceIds.map((id) => `"${id}"`).join(", ")}]`,
    `builtAt: "${fm.builtAt}"`,
    "---",
  ].join("\n");
  return `${yaml}\n\n${summary}\n`;
}

export function parseIsoDate(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

export function parseIsoHour(iso: string): string {
  return iso.slice(11, 13); // HH
}

// Returns ISO week key: YYYY-WW
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, "0")}`;
}

// ── TmtBuilder ──────────────────────────────────────────────────────────────

export type SummarizeFn = (memories: string[], level: TmtLevel) => Promise<string>;

export class TmtBuilder {
  constructor(
    private readonly baseDir: string,
    private readonly cfg: TmtConfig,
  ) {}

  /**
   * Called after each consolidation pass.
   * Groups memories by hour, builds any missing hour nodes,
   * then rolls up to day → week → persona if needed.
   * All errors are caught and logged; never throws.
   */
  async maybeRebuildNodes(
    memories: MemoryEntry[],
    summarize: SummarizeFn,
  ): Promise<void> {
    if (!this.cfg.temporalMemoryTreeEnabled || memories.length === 0) return;
    try {
      await mkdir(tmtDir(this.baseDir), { recursive: true });
      await this.buildHourNodes(memories, summarize);
      await this.buildDayNodes(memories, summarize);
      // Week and persona are built lazily on day rollup — deferred until Task 4
    } catch (err) {
      console.warn(`[engram] tmt: rebuild failed (ignored): ${err}`);
    }
  }

  private async buildHourNodes(memories: MemoryEntry[], summarize: SummarizeFn): Promise<void> {
    // Group by date+hour
    const byHour = new Map<string, MemoryEntry[]>();
    for (const m of memories) {
      const date = parseIsoDate(m.created);
      const hour = parseIsoHour(m.created);
      const key = `${date}::${hour}`;
      if (!byHour.has(key)) byHour.set(key, []);
      byHour.get(key)!.push(m);
    }

    for (const [key, entries] of byHour) {
      if (entries.length < this.cfg.tmtHourlyMinMemories) continue;
      const [date, hour] = key.split("::");
      const nodePath = hourNodePath(this.baseDir, date, hour);

      // Skip if already built
      if (fs.existsSync(nodePath)) continue;

      const summary = await summarize(entries.map((e) => e.content), "hour");
      const sortedCreated = entries.map((e) => e.created).sort();
      const fm: TmtNodeFrontmatter = {
        level: "hour",
        periodStart: sortedCreated[0],
        periodEnd: sortedCreated[sortedCreated.length - 1],
        memoryCount: entries.length,
        sourceIds: entries.map((e) => e.id),
        builtAt: new Date().toISOString(),
      };
      await mkdir(path.dirname(nodePath), { recursive: true });
      await writeFile(nodePath, serialiseTmtNode(fm, summary), "utf8");
    }
  }

  private async buildDayNodes(memories: MemoryEntry[], summarize: SummarizeFn): Promise<void> {
    // Group by date
    const byDate = new Map<string, MemoryEntry[]>();
    for (const m of memories) {
      const date = parseIsoDate(m.created);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(m);
    }

    for (const [date, entries] of byDate) {
      const nodePath = dayNodePath(this.baseDir, date);
      // Rebuild day node if it doesn't exist or if memory count changed
      let shouldBuild = !fs.existsSync(nodePath);
      if (!shouldBuild) {
        try {
          const existing = await readFile(nodePath, "utf8");
          const countMatch = existing.match(/memoryCount: (\d+)/);
          if (countMatch && parseInt(countMatch[1], 10) < entries.length) {
            shouldBuild = true; // more memories now — rebuild
          }
        } catch { shouldBuild = true; }
      }
      if (!shouldBuild) continue;

      const summary = await summarize(entries.map((e) => e.content), "day");
      const sortedCreated = entries.map((e) => e.created).sort();
      const fm: TmtNodeFrontmatter = {
        level: "day",
        periodStart: `${date}T00:00:00.000Z`,
        periodEnd: `${date}T23:59:59.999Z`,
        memoryCount: entries.length,
        sourceIds: entries.map((e) => e.id),
        builtAt: new Date().toISOString(),
      };
      await mkdir(path.dirname(nodePath), { recursive: true });
      await writeFile(nodePath, serialiseTmtNode(fm, summary), "utf8");
    }
  }

  /**
   * Return the summary text of the most relevant TMT node for a given prompt.
   * Preference: day node for today > most recent day node > most recent hour node.
   * Returns null if no nodes exist or feature is disabled.
   */
  async getMostRelevantNode(): Promise<{ level: TmtLevel; summary: string } | null> {
    if (!this.cfg.temporalMemoryTreeEnabled) return null;
    try {
      const dir = tmtDir(this.baseDir);
      if (!fs.existsSync(dir)) return null;

      // Try today's day node first
      const today = new Date().toISOString().slice(0, 10);
      const todayDay = dayNodePath(this.baseDir, today);
      if (fs.existsSync(todayDay)) {
        const content = await readFile(todayDay, "utf8");
        const summary = content.replace(/^---[\s\S]*?---\n\n?/, "").trim();
        if (summary) return { level: "day", summary };
      }

      // Find most recent date directory
      let entries: string[] = [];
      try { entries = await readdir(dir); } catch { return null; }
      const dateDirs = entries.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort().reverse();

      for (const dateDir of dateDirs) {
        const dayPath = dayNodePath(this.baseDir, dateDir);
        if (fs.existsSync(dayPath)) {
          const content = await readFile(dayPath, "utf8");
          const summary = content.replace(/^---[\s\S]*?---\n\n?/, "").trim();
          if (summary) return { level: "day", summary };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
