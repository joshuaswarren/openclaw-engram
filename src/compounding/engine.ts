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

type FeedbackEntryWithProvenance = {
  entry: SharedFeedbackEntry;
  sourceLine: number;
  sourcePath: string;
  entryId: string;
};

type PatternWithProvenance = {
  pattern: string;
  provenance: string[];
};

type ActionOutcomeCounts = {
  applied: number;
  skipped: number;
  failed: number;
  unknown: number;
};

type ActionOutcomeSummary = {
  action: string;
  counts: ActionOutcomeCounts;
  total: number;
  weightedScore: number;
  provenance: string[];
};

type PromotionCandidate = {
  action: string;
  score: number;
  rationale: string;
  outcome: ActionOutcomeCounts;
  provenance: string[];
};

type WeeklyActionEvent = {
  line: number;
  action: string;
  outcome: "applied" | "skipped" | "failed" | "unknown";
  policyDecision: "deny" | "defer" | null;
  namespace: string;
  reason: string | null;
};

export type TierMigrationCycleTrigger = "extraction" | "maintenance";
export interface TierMigrationCycleBudget {
  limit: number;
  scanLimit: number;
  minIntervalMs: number;
}

export function defaultTierMigrationCycleBudget(
  config: Pick<PluginConfig, "qmdTierAutoBackfillEnabled">,
  trigger: TierMigrationCycleTrigger,
): TierMigrationCycleBudget {
  if (trigger === "extraction") {
    const limit = 12;
    return {
      limit,
      scanLimit: limit * 4,
      minIntervalMs: 60_000,
    };
  }
  const limit = config.qmdTierAutoBackfillEnabled ? 200 : 50;
  return {
    limit,
    scanLimit: limit * 4,
    minIntervalMs: config.qmdTierAutoBackfillEnabled ? 120_000 : 300_000,
  };
}

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
  private readonly rubricsPath: string;
  private readonly mistakesPath: string;
  private readonly feedbackInboxPath: string;
  private readonly identityAnchorPath: string;
  private readonly identityIncidentsDir: string;
  private readonly identityAuditWeeklyDir: string;
  private readonly identityAuditMonthlyDir: string;
  private readonly identityImprovementLoopsPath: string;
  private readonly memoryActionEventsPath: string;

  constructor(private readonly config: PluginConfig) {
    this.weeklyDir = path.join(config.memoryDir, "compounding", "weekly");
    this.rubricsPath = path.join(config.memoryDir, "compounding", "rubrics.md");
    this.mistakesPath = path.join(config.memoryDir, "compounding", "mistakes.json");
    this.feedbackInboxPath = path.join(sharedContextDir(config), "feedback", "inbox.jsonl");
    this.identityAnchorPath = path.join(config.memoryDir, "identity", "identity-anchor.md");
    this.identityIncidentsDir = path.join(config.memoryDir, "identity", "incidents");
    this.identityAuditWeeklyDir = path.join(config.memoryDir, "identity", "audits", "weekly");
    this.identityAuditMonthlyDir = path.join(config.memoryDir, "identity", "audits", "monthly");
    this.identityImprovementLoopsPath = path.join(config.memoryDir, "identity", "improvement-loops.md");
    this.memoryActionEventsPath = path.join(config.memoryDir, "state", "memory-actions.jsonl");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.weeklyDir, { recursive: true });
    await mkdir(path.dirname(this.mistakesPath), { recursive: true });
    await mkdir(path.dirname(this.rubricsPath), { recursive: true });
  }

  async synthesizeWeekly(opts?: {
    weekId?: string;
  }): Promise<{ weekId: string; reportPath: string; mistakesCount: number; rubricsPath: string; promotionCandidateCount: number }> {
    await this.ensureDirs();
    const weekId = opts?.weekId ?? isoWeekId(new Date());

    const entries = await this.readFeedbackEntriesForWeek(weekId);
    const actionPatterns = await this.readActionFailurePatternsForWeek(weekId);
    const outcomeSummary = await this.readActionOutcomeSummaryForWeek(weekId);
    const promotionCandidates = this.config.compoundingSemanticEnabled
      ? this.derivePromotionCandidates(outcomeSummary)
      : [];
    const mistakes = this.buildMistakes(entries, actionPatterns);
    const continuity = this.config.continuityAuditEnabled
      ? await this.readContinuityAuditReferences(weekId)
      : { monthId: monthIdFromIsoWeek(weekId), weeklyPath: null, monthlyPath: null };

    // Write weekly report (always, even if empty: "day-one outcomes").
    const reportPath = path.join(this.weeklyDir, `${weekId}.md`);
    const md = this.formatWeeklyReport(weekId, entries, mistakes.patterns, mistakes.details, continuity, outcomeSummary, promotionCandidates);
    await writeFile(reportPath, md, "utf-8");

    // Write stable rubric artifact.
    const rubrics = this.formatRubrics(entries, outcomeSummary);
    await writeFile(this.rubricsPath, rubrics, "utf-8");

    // Update mistakes.json (always).
    await writeFile(
      this.mistakesPath,
      JSON.stringify({ updatedAt: mistakes.updatedAt, patterns: mistakes.patterns }, null, 2) + "\n",
      "utf-8",
    );

    log.info(`compounding: wrote weekly=${reportPath} rubrics=${this.rubricsPath} mistakes=${this.mistakesPath}`);
    return { weekId, reportPath, rubricsPath: this.rubricsPath, mistakesCount: mistakes.patterns.length, promotionCandidateCount: promotionCandidates.length };
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

  tierMigrationCycleBudget(trigger: TierMigrationCycleTrigger): TierMigrationCycleBudget {
    return defaultTierMigrationCycleBudget(this.config, trigger);
  }

  private async readFeedbackEntriesForWeek(weekId: string): Promise<FeedbackEntryWithProvenance[]> {
    // Minimal implementation: includes entries where date starts with any day in the ISO week.
    // We approximate by taking all entries and filtering by computed isoWeekId(date).
    const out: FeedbackEntryWithProvenance[] = [];
    try {
      const raw = await readFile(this.feedbackInboxPath, "utf-8");
      const lines = raw.split("\n");
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const parsed = SharedFeedbackEntrySchema.safeParse(obj);
          if (!parsed.success) continue;
          const d = new Date(parsed.data.date);
          if (!Number.isFinite(d.getTime())) continue;
          if (isoWeekId(d) !== weekId) continue;
          const sourceLine = idx + 1;
          out.push({
            entry: parsed.data,
            sourceLine,
            sourcePath: this.feedbackInboxPath,
            entryId: `${parsed.data.agent}-${parsed.data.date}-${sourceLine}`.replace(/[^a-zA-Z0-9._:-]/g, "_"),
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // missing feedback is normal
    }
    return out;
  }

  private async readActionFailurePatternsForWeek(weekId: string): Promise<string[]> {
    const out: string[] = [];
    const events = await this.readActionEventsForWeek(weekId);
    for (const event of events) {
      const failed = event.outcome === "failed" || event.outcome === "skipped";
      if (!failed && event.policyDecision === null) continue;
      const suffix = event.reason && event.reason.trim().length > 0
        ? ` - ${event.reason.trim().slice(0, 140)}`
        : "";
      out.push(
        `memory-action/${event.namespace}: ${event.action} ${event.outcome}${event.policyDecision ? `/${event.policyDecision}` : ""}${suffix}`,
      );
    }
    return out;
  }

  private async readActionEventsForWeek(weekId: string): Promise<WeeklyActionEvent[]> {
    const out: WeeklyActionEvent[] = [];
    try {
      const raw = await readFile(this.memoryActionEventsPath, "utf-8");
      const lines = raw.split("\n");
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            timestamp?: string;
            action?: string;
            outcome?: string;
            policyDecision?: string;
            namespace?: string;
            reason?: string;
          };
          if (typeof parsed.timestamp !== "string" || typeof parsed.action !== "string") continue;
          const ts = new Date(parsed.timestamp);
          if (!Number.isFinite(ts.getTime()) || isoWeekId(ts) !== weekId) continue;
          out.push({
            line: idx + 1,
            action: parsed.action,
            outcome: parsed.outcome === "applied" || parsed.outcome === "skipped" || parsed.outcome === "failed"
              ? parsed.outcome
              : "unknown",
            policyDecision: parsed.policyDecision === "deny" || parsed.policyDecision === "defer"
              ? parsed.policyDecision
              : null,
            namespace: typeof parsed.namespace === "string" && parsed.namespace.length > 0 ? parsed.namespace : "default",
            reason: typeof parsed.reason === "string" ? parsed.reason : null,
          });
        } catch {
          // Ignore malformed rows (fail-open).
        }
      }
    } catch {
      // Missing action telemetry is allowed.
    }
    return out;
  }

  private async readActionOutcomeSummaryForWeek(weekId: string): Promise<ActionOutcomeSummary[]> {
    const byAction = new Map<string, { counts: ActionOutcomeCounts; provenance: Set<string> }>();
    const events = await this.readActionEventsForWeek(weekId);
    for (const event of events) {
      const key = event.action;
      const acc = byAction.get(key) ?? {
        counts: { applied: 0, skipped: 0, failed: 0, unknown: 0 },
        provenance: new Set<string>(),
      };
      if (event.outcome === "applied") acc.counts.applied += 1;
      else if (event.outcome === "skipped") acc.counts.skipped += 1;
      else if (event.outcome === "failed") acc.counts.failed += 1;
      else acc.counts.unknown += 1;
      acc.provenance.add(`${path.basename(this.memoryActionEventsPath)}:L${event.line}`);
      byAction.set(key, acc);
    }

    const out: ActionOutcomeSummary[] = [];
    for (const [action, data] of byAction.entries()) {
      const total = data.counts.applied + data.counts.skipped + data.counts.failed + data.counts.unknown;
      if (total <= 0) continue;
      // Conservative weighting: reward applied, penalize skipped/failed.
      const weightedScore = Number((((data.counts.applied * 1) - (data.counts.skipped * 0.5) - (data.counts.failed * 1.5)) / total).toFixed(3));
      out.push({
        action,
        counts: data.counts,
        total,
        weightedScore,
        provenance: [...data.provenance].sort().slice(0, 8),
      });
    }
    out.sort((a, b) => b.total - a.total || b.weightedScore - a.weightedScore || a.action.localeCompare(b.action));
    return out;
  }

  private derivePromotionCandidates(summary: ActionOutcomeSummary[]): PromotionCandidate[] {
    const out: PromotionCandidate[] = [];
    for (const item of summary) {
      if (item.total < 3) continue;
      if (item.weightedScore < 0.3) continue;
      out.push({
        action: item.action,
        score: item.weightedScore,
        rationale: "High applied ratio with low failure/skips in weekly outcome telemetry.",
        outcome: item.counts,
        provenance: item.provenance,
      });
    }
    return out
      .sort((a, b) => b.score - a.score || a.action.localeCompare(b.action))
      .slice(0, 10);
  }

  private buildMistakes(
    entries: FeedbackEntryWithProvenance[],
    actionPatterns: string[] = [],
  ): MistakesFile & { details: PatternWithProvenance[] } {
    const patterns: PatternWithProvenance[] = [];
    for (const wrapped of entries) {
      const e = wrapped.entry;
      const provenance = [`${path.basename(wrapped.sourcePath)}:L${wrapped.sourceLine}#${wrapped.entryId}`];
      if (e.learning && e.learning.trim().length > 0) {
        patterns.push({ pattern: `${e.agent}: ${e.learning.trim()}`, provenance });
        continue;
      }
      if (e.decision === "rejected") {
        patterns.push({ pattern: `${e.agent}: ${e.reason.trim()}`.slice(0, 240), provenance });
      }
    }

    for (const p of actionPatterns) {
      patterns.push({ pattern: p, provenance: [`${path.basename(this.memoryActionEventsPath)}:*`] });
    }

    const byPattern = new Map<string, Set<string>>();
    for (const p of patterns) {
      const set = byPattern.get(p.pattern) ?? new Set<string>();
      for (const prov of p.provenance) set.add(prov);
      byPattern.set(p.pattern, set);
    }

    const details = [...byPattern.entries()]
      .map(([pattern, provenance]) => ({ pattern, provenance: [...provenance].sort() }))
      .slice(0, 500);
    return { updatedAt: new Date().toISOString(), patterns: details.map((d) => d.pattern), details };
  }

  private formatWeeklyReport(
    weekId: string,
    entries: FeedbackEntryWithProvenance[],
    patterns: string[],
    patternDetails: PatternWithProvenance[],
    continuity: { monthId: string; weeklyPath: string | null; monthlyPath: string | null },
    outcomeSummary: ActionOutcomeSummary[],
    promotionCandidates: PromotionCandidate[],
  ): string {
    const byAgent = new Map<string, FeedbackEntryWithProvenance[]>();
    for (const wrapped of entries) {
      const list = byAgent.get(wrapped.entry.agent) ?? [];
      list.push(wrapped);
      byAgent.set(wrapped.entry.agent, list);
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
        const approved = list.filter((e) => e.entry.decision === "approved").length;
        const awf = list.filter((e) => e.entry.decision === "approved_with_feedback").length;
        const rejected = list.filter((e) => e.entry.decision === "rejected").length;
        lines.push(`### ${agent}`);
        lines.push(`- approved: ${approved}`);
        lines.push(`- approved_with_feedback: ${awf}`);
        lines.push(`- rejected: ${rejected}`);
        const provenance = list
          .slice(0, 3)
          .map((e) => `${path.basename(e.sourcePath)}:L${e.sourceLine}#${e.entryId}`);
        if (provenance.length > 0) {
          lines.push(`- provenance: ${provenance.join(", ")}`);
        }
        lines.push("");
      }
    }

    lines.push("## Patterns (Avoid / Prefer)");
    if (patterns.length === 0) {
      lines.push("- (none yet)");
    } else {
      const detailMap = new Map(patternDetails.map((d) => [d.pattern, d.provenance]));
      for (const p of patterns.slice(0, 100)) {
        const provenance = detailMap.get(p) ?? [];
        if (provenance.length > 0) {
          lines.push(`- ${p} _(source: ${provenance.join(", ")})_`);
        } else {
          lines.push(`- ${p}`);
        }
      }
    }
    lines.push("");

    lines.push("## Outcome Weighting");
    if (outcomeSummary.length === 0) {
      lines.push("- (no action outcomes recorded this week)");
    } else {
      for (const item of outcomeSummary.slice(0, 20)) {
        lines.push(
          `- ${item.action}: applied=${item.counts.applied}, skipped=${item.counts.skipped}, failed=${item.counts.failed}, unknown=${item.counts.unknown}, weight=${item.weightedScore} _(source: ${item.provenance.join(", ")})_`,
        );
      }
    }
    lines.push("");

    if (this.config.compoundingSemanticEnabled) {
      lines.push("## Promotion Candidates (Advisory)");
      if (promotionCandidates.length === 0) {
        lines.push("- (no advisory promotion candidates this week)");
      } else {
        for (const candidate of promotionCandidates) {
          lines.push(
            `- ${candidate.action} (score=${candidate.score}): ${candidate.rationale} outcomes[a=${candidate.outcome.applied}, s=${candidate.outcome.skipped}, f=${candidate.outcome.failed}, u=${candidate.outcome.unknown}] _(source: ${candidate.provenance.join(", ")})_`,
          );
        }
      }
      lines.push("");
      lines.push("_Advisory only: no automatic promotion write is performed by this report._");
      lines.push("");
    }

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

  private formatRubrics(entries: FeedbackEntryWithProvenance[], outcomeSummary: ActionOutcomeSummary[]): string {
    const lines: string[] = [
      "# Compounding Rubrics",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      "Stable, deterministic rubric snapshot generated from weekly feedback + action outcomes.",
      "",
    ];

    const byAgent = new Map<string, FeedbackEntryWithProvenance[]>();
    for (const wrapped of entries) {
      const list = byAgent.get(wrapped.entry.agent) ?? [];
      list.push(wrapped);
      byAgent.set(wrapped.entry.agent, list);
    }

    lines.push("## Agent Rubrics");
    if (byAgent.size === 0) {
      lines.push("- (none yet)");
    } else {
      for (const [agent, list] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`### ${agent}`);
        const learnings = list
          .filter((w) => (w.entry.learning ?? "").trim().length > 0 || w.entry.decision === "rejected")
          .slice(0, 8);
        if (learnings.length === 0) {
          lines.push("- No rubric deltas this week.");
        } else {
          for (const item of learnings) {
            const note = ((item.entry.learning && item.entry.learning.trim().length > 0)
              ? item.entry.learning
              : item.entry.reason).trim();
            lines.push(`- ${note} _(source: ${path.basename(item.sourcePath)}:L${item.sourceLine}#${item.entryId})_`);
          }
        }
        lines.push("");
      }
    }

    lines.push("## Action Outcome Signals");
    if (outcomeSummary.length === 0) {
      lines.push("- (none yet)");
    } else {
      for (const item of outcomeSummary.slice(0, 20)) {
        lines.push(
          `- ${item.action}: weight=${item.weightedScore} (applied=${item.counts.applied}, skipped=${item.counts.skipped}, failed=${item.counts.failed}, unknown=${item.counts.unknown})`,
        );
      }
    }
    lines.push("");
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
