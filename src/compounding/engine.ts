import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { log } from "../logger.js";
import type { ContinuityIncidentRecord, PluginConfig } from "../types.js";
import { SharedFeedbackEntrySchema, type SharedFeedbackEntry } from "../shared-context/manager.js";
import { parseContinuityIncident, parseContinuityImprovementLoops } from "../identity-continuity.js";

type MistakesFile = {
  updatedAt: string;
  patterns: string[];
};

function isoWeekId(d: Date): string {
  // ISO week based on Thursday
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const yyyy = dt.getUTCFullYear();
  return `${yyyy}-W${String(week).padStart(2, "0")}`;
}

function isoMonthId(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthIdFromIsoWeek(weekId: string): string {
  const match = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return isoMonthId(new Date());
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const isoWeekOneMonday = new Date(jan4);
  isoWeekOneMonday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(isoWeekOneMonday);
  monday.setUTCDate(isoWeekOneMonday.getUTCDate() + (week - 1) * 7);
  return isoMonthId(monday);
}

function sharedContextDir(config: PluginConfig): string {
  if (typeof config.sharedContextDir === "string" && config.sharedContextDir.length > 0) {
    return config.sharedContextDir;
  }
  return path.join(os.homedir(), ".openclaw", "workspace", "shared-context");
}

function cadenceStaleWindowMs(cadence: "daily" | "weekly" | "monthly" | "quarterly"): number {
  switch (cadence) {
    case "daily":
      return 2 * 24 * 60 * 60 * 1000;
    case "weekly":
      return 10 * 24 * 60 * 60 * 1000;
    case "monthly":
      return 45 * 24 * 60 * 60 * 1000;
    case "quarterly":
      return 120 * 24 * 60 * 60 * 1000;
    default:
      return 45 * 24 * 60 * 60 * 1000;
  }
}

export class CompoundingEngine {
  private readonly weeklyDir: string;
  private readonly mistakesPath: string;
  private readonly feedbackInboxPath: string;
  private readonly identityAnchorPath: string;
  private readonly identityIncidentsDir: string;
  private readonly identityAuditWeeklyDir: string;
  private readonly identityAuditMonthlyDir: string;
  private readonly identityImprovementLoopsPath: string;

  constructor(private readonly config: PluginConfig) {
    this.weeklyDir = path.join(config.memoryDir, "compounding", "weekly");
    this.mistakesPath = path.join(config.memoryDir, "compounding", "mistakes.json");
    this.feedbackInboxPath = path.join(sharedContextDir(config), "feedback", "inbox.jsonl");
    this.identityAnchorPath = path.join(config.memoryDir, "identity", "identity-anchor.md");
    this.identityIncidentsDir = path.join(config.memoryDir, "identity", "incidents");
    this.identityAuditWeeklyDir = path.join(config.memoryDir, "identity", "audits", "weekly");
    this.identityAuditMonthlyDir = path.join(config.memoryDir, "identity", "audits", "monthly");
    this.identityImprovementLoopsPath = path.join(config.memoryDir, "identity", "improvement-loops.md");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.weeklyDir, { recursive: true });
    await mkdir(path.dirname(this.mistakesPath), { recursive: true });
  }

  async synthesizeWeekly(opts?: { weekId?: string }): Promise<{ weekId: string; reportPath: string; mistakesCount: number }> {
    await this.ensureDirs();
    const weekId = opts?.weekId ?? isoWeekId(new Date());

    const entries = await this.readFeedbackEntriesForWeek(weekId);
    const mistakes = this.buildMistakes(entries);
    const continuity = this.config.continuityAuditEnabled
      ? await this.readContinuityAuditReferences(weekId)
      : { monthId: monthIdFromIsoWeek(weekId), weeklyPath: null, monthlyPath: null };

    // Write weekly report (always, even if empty: "day-one outcomes").
    const reportPath = path.join(this.weeklyDir, `${weekId}.md`);
    const md = this.formatWeeklyReport(weekId, entries, mistakes.patterns, continuity);
    await writeFile(reportPath, md, "utf-8");

    // Update mistakes.json (always).
    await writeFile(this.mistakesPath, JSON.stringify(mistakes, null, 2) + "\n", "utf-8");

    log.info(`compounding: wrote weekly=${reportPath} mistakes=${this.mistakesPath}`);
    return { weekId, reportPath, mistakesCount: mistakes.patterns.length };
  }

  async synthesizeContinuityAudit(opts?: {
    period?: "weekly" | "monthly";
    key?: string;
  }): Promise<{ period: "weekly" | "monthly"; key: string; reportPath: string }> {
    const period = opts?.period === "monthly" ? "monthly" : "weekly";
    const key = opts?.key?.trim() || (period === "weekly" ? isoWeekId(new Date()) : isoMonthId(new Date()));
    const nowIso = new Date().toISOString();
    const [anchorPresent, improvementLoopsRaw, openIncidents, closedIncidents, mistakes] = await Promise.all([
      this.readNonEmptyFile(this.identityAnchorPath),
      this.readOptionalFile(this.identityImprovementLoopsPath),
      this.readContinuityIncidents(200, "open"),
      this.readContinuityIncidents(200, "closed"),
      this.readMistakes(),
    ]);
    const improvementLoops = improvementLoopsRaw ? parseContinuityImprovementLoops(improvementLoopsRaw) : [];
    const activeLoops = improvementLoops.filter((loop) => loop.status === "active");
    const staleActiveLoops = activeLoops.filter((loop) => {
      const reviewedAt = Date.parse(loop.lastReviewed);
      if (!Number.isFinite(reviewedAt)) return true;
      return Date.now() - reviewedAt > cadenceStaleWindowMs(loop.cadence);
    });
    const hardeningCandidates: string[] = [];
    if (!anchorPresent) {
      hardeningCandidates.push("Create/update identity anchor baseline and verify recovery injection path.");
    }
    if (openIncidents.length > 0) {
      hardeningCandidates.push(
        `Close or downgrade ${openIncidents.length} open continuity incident${openIncidents.length === 1 ? "" : "s"}.`,
      );
    }
    if (improvementLoops.length === 0) {
      hardeningCandidates.push("Initialize continuity improvement-loops register with cadence and kill conditions.");
    } else if (staleActiveLoops.length > 0) {
      hardeningCandidates.push(
        `Review stale active continuity loop${staleActiveLoops.length === 1 ? "" : "s"}: ${staleActiveLoops
          .slice(0, 3)
          .map((loop) => loop.id)
          .join(", ")}.`,
      );
    }
    if ((mistakes?.patterns.length ?? 0) > 0) {
      hardeningCandidates.push("Review latest compounding mistakes and convert one pattern into preventive continuity rule.");
    }
    const nextAction = hardeningCandidates[0] ?? "No critical drift detected; keep weekly/monthly continuity audit cadence.";

    const lines: string[] = [
      `# Continuity Audit — ${period} ${key}`,
      "",
      `Generated: ${nowIso}`,
      `Scope: ${period}`,
      "",
      "## Signal Summary",
      `- Identity anchor present: ${anchorPresent ? "yes" : "no"}`,
      `- Improvement loops tracked: ${improvementLoops.length}`,
      `- Active improvement loops: ${activeLoops.length}`,
      `- Stale active loops: ${staleActiveLoops.length}`,
      `- Open incidents: ${openIncidents.length}`,
      `- Closed incidents: ${closedIncidents.length}`,
      `- Compounding mistake patterns: ${mistakes?.patterns.length ?? 0}`,
      "",
      "## Drift Checks",
      `- Identity anchor drift: ${anchorPresent ? "pass" : "needs attention"}`,
      `- Incident backlog: ${openIncidents.length === 0 ? "pass" : "needs attention"}`,
      `- Improvement-loop coverage: ${improvementLoops.length > 0 ? "pass" : "needs attention"}`,
      `- Improvement-loop freshness: ${staleActiveLoops.length === 0 ? "pass" : "needs attention"}`,
      "",
      "## Stale Rule Detection",
      `- Open incidents older than closure window: ${openIncidents.length > 0 ? "possible" : "none detected"}`,
      `- Stale active continuity loops: ${staleActiveLoops.length > 0 ? staleActiveLoops.map((l) => l.id).join(", ") : "none detected"}`,
      `- Preventive rule coverage on closed incidents: ${
        closedIncidents.some((i) => (i.preventiveRule ?? "").trim().length > 0) ? "present" : "not detected"
      }`,
      "",
      "## Next Hardening Action",
      `- ${nextAction}`,
      "",
      "## Open Incident IDs",
      ...(openIncidents.length > 0 ? openIncidents.slice(0, 20).map((i) => `- ${i.id}`) : ["- (none)"]),
      "",
    ];

    const dir = period === "weekly" ? this.identityAuditWeeklyDir : this.identityAuditMonthlyDir;
    await mkdir(dir, { recursive: true });
    const reportPath = path.join(dir, `${key}.md`);
    await writeFile(reportPath, lines.join("\n"), "utf-8");
    return { period, key, reportPath };
  }

  async readMistakes(): Promise<MistakesFile | null> {
    try {
      const raw = await readFile(this.mistakesPath, "utf-8");
      const parsed = JSON.parse(raw) as MistakesFile;
      if (!parsed || !Array.isArray(parsed.patterns)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async readFeedbackEntriesForWeek(weekId: string): Promise<SharedFeedbackEntry[]> {
    // Minimal implementation: includes entries where date starts with any day in the ISO week.
    // We approximate by taking all entries and filtering by computed isoWeekId(date).
    const out: SharedFeedbackEntry[] = [];
    try {
      const raw = await readFile(this.feedbackInboxPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const parsed = SharedFeedbackEntrySchema.safeParse(obj);
          if (!parsed.success) continue;
          const d = new Date(parsed.data.date);
          if (!Number.isFinite(d.getTime())) continue;
          if (isoWeekId(d) === weekId) out.push(parsed.data);
        } catch {
          // ignore
        }
      }
    } catch {
      // missing feedback is normal
    }
    return out;
  }

  private buildMistakes(entries: SharedFeedbackEntry[]): MistakesFile {
    const patterns: string[] = [];
    for (const e of entries) {
      if (e.learning && e.learning.trim().length > 0) {
        patterns.push(`${e.agent}: ${e.learning.trim()}`);
        continue;
      }
      if (e.decision === "rejected") {
        patterns.push(`${e.agent}: ${e.reason.trim()}`.slice(0, 240));
      }
    }

    const uniq = Array.from(new Set(patterns)).slice(0, 500);
    return { updatedAt: new Date().toISOString(), patterns: uniq };
  }

  private formatWeeklyReport(
    weekId: string,
    entries: SharedFeedbackEntry[],
    patterns: string[],
    continuity: { monthId: string; weeklyPath: string | null; monthlyPath: string | null },
  ): string {
    const byAgent = new Map<string, SharedFeedbackEntry[]>();
    for (const e of entries) {
      const list = byAgent.get(e.agent) ?? [];
      list.push(e);
      byAgent.set(e.agent, list);
    }

    const lines: string[] = [
      `# Weekly Compounding — ${weekId}`,
      "",
      "This file is generated by Engram's compounding engine (v5.0).",
      "",
      "## Summary",
      `- Feedback entries: ${entries.length}`,
      `- Mistake patterns: ${patterns.length}`,
      "",
      "## By Agent",
    ];

    if (byAgent.size === 0) {
      lines.push("- (none)");
    } else {
      for (const [agent, list] of Array.from(byAgent.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        const approved = list.filter((e) => e.decision === "approved").length;
        const awf = list.filter((e) => e.decision === "approved_with_feedback").length;
        const rejected = list.filter((e) => e.decision === "rejected").length;
        lines.push(`### ${agent}`);
        lines.push(`- approved: ${approved}`);
        lines.push(`- approved_with_feedback: ${awf}`);
        lines.push(`- rejected: ${rejected}`);
        lines.push("");
      }
    }

    lines.push("## Patterns (Avoid / Prefer)");
    if (patterns.length === 0) {
      lines.push("- (none yet)");
    } else {
      for (const p of patterns.slice(0, 100)) lines.push(`- ${p}`);
    }
    lines.push("");
    if (this.config.continuityAuditEnabled) {
      lines.push("## Continuity Audits");
      if (continuity.weeklyPath) {
        lines.push(`- weekly: ${continuity.weeklyPath}`);
      } else {
        lines.push(`- weekly: (missing for ${weekId})`);
      }
      if (continuity.monthlyPath) {
        lines.push(`- monthly: ${continuity.monthlyPath}`);
      } else {
        lines.push(`- monthly: (missing for ${continuity.monthId})`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private async readNonEmptyFile(filePath: string): Promise<boolean> {
    try {
      const raw = await readFile(filePath, "utf-8");
      return raw.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async readOptionalFile(filePath: string): Promise<string | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      return raw.trim().length > 0 ? raw : null;
    } catch {
      return null;
    }
  }

  private async readContinuityIncidents(
    limit: number = 200,
    state?: ContinuityIncidentRecord["state"],
  ): Promise<ContinuityIncidentRecord[]> {
    const normalizedLimit = Number.isFinite(limit) ? limit : 0;
    const cappedLimit = Math.max(0, Math.floor(normalizedLimit));
    if (cappedLimit === 0) return [];
    const incidents: ContinuityIncidentRecord[] = [];
    try {
      const names = await readdir(this.identityIncidentsDir);
      const files = names.filter((n) => n.endsWith(".md")).sort().reverse();
      for (const file of files) {
        if (incidents.length >= cappedLimit) break;
        const filePath = path.join(this.identityIncidentsDir, file);
        try {
          const raw = await readFile(filePath, "utf-8");
          const parsed = parseContinuityIncident(raw);
          if (!parsed) continue;
          if (state && parsed.state !== state) continue;
          incidents.push(parsed);
        } catch {
          // fail-open
        }
      }
    } catch {
      // fail-open
    }
    return incidents;
  }

  private async readContinuityAuditReferences(weekId: string): Promise<{
    weekId: string;
    monthId: string;
    weeklyPath: string | null;
    monthlyPath: string | null;
  }> {
    const monthId = monthIdFromIsoWeek(weekId);
    const weeklyPath = path.join(this.identityAuditWeeklyDir, `${weekId}.md`);
    const monthlyPath = path.join(this.identityAuditMonthlyDir, `${monthId}.md`);
    const weeklyExists = await this.readNonEmptyFile(weeklyPath);
    const monthlyExists = await this.readNonEmptyFile(monthlyPath);
    return {
      weekId,
      monthId,
      weeklyPath: weeklyExists ? weeklyPath : null,
      monthlyPath: monthlyExists ? monthlyPath : null,
    };
  }
}
