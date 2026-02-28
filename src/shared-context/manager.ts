import { mkdir, readFile, readdir, appendFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";

export const SharedFeedbackEntrySchema = z.object({
  agent: z.string().min(1),
  decision: z.enum(["approved", "approved_with_feedback", "rejected"]),
  reason: z.string().min(1),
  date: z.string().min(8), // ISO-ish; keep loose
  learning: z.string().optional(),
  outcome: z.string().optional(),
  refs: z.array(z.string()).optional(),
});

export type SharedFeedbackEntry = z.infer<typeof SharedFeedbackEntrySchema>;

function safeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "output";
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const CROSS_SIGNAL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
  "agent",
  "output",
  "today",
  "daily",
  "notes",
  "note",
  "summary",
]);

function extractTopicTokens(text: string, maxTokens: number = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !CROSS_SIGNAL_STOPWORDS.has(token));

  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxTokens) break;
  }
  return out;
}

interface SharedCrossSignalSource {
  agent: string;
  path: string;
  title: string;
  topics: string[];
}

interface SharedCrossSignalOverlap {
  token: string;
  agents: string[];
  sourcePaths: string[];
  agentCount: number;
}

interface SharedCrossSignalReport {
  date: string;
  generatedAt: string;
  sourceCount: number;
  feedbackCount: number;
  feedbackByDecision: Record<"approved" | "approved_with_feedback" | "rejected", number>;
  sources: SharedCrossSignalSource[];
  overlaps: SharedCrossSignalOverlap[];
}

export interface SharedDailyCurationResult {
  date: string;
  roundtablePath: string;
  crossSignalsPath: string;
  overlapCount: number;
}

export class SharedContextManager {
  readonly dir: string;
  private readonly prioritiesPath: string;
  private readonly prioritiesInboxPath: string;
  private readonly outputsDir: string;
  private readonly roundtableDir: string;
  private readonly feedbackDir: string;
  private readonly feedbackInboxPath: string;
  private readonly crossSignalsDir: string;

  constructor(private readonly config: PluginConfig) {
    const base =
      typeof config.sharedContextDir === "string" && config.sharedContextDir.length > 0
        ? config.sharedContextDir
        : path.join(os.homedir(), ".openclaw", "workspace", "shared-context");

    this.dir = base;
    this.prioritiesPath = path.join(base, "priorities.md");
    this.prioritiesInboxPath = path.join(base, "priorities.inbox.md");
    this.outputsDir = path.join(base, "agent-outputs");
    this.roundtableDir = path.join(base, "roundtable");
    this.feedbackDir = path.join(base, "feedback");
    this.feedbackInboxPath = path.join(this.feedbackDir, "inbox.jsonl");
    this.crossSignalsDir = path.join(base, "cross-signals");
  }

  async ensureStructure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.outputsDir, { recursive: true });
    await mkdir(this.roundtableDir, { recursive: true });
    await mkdir(this.feedbackDir, { recursive: true });
    await mkdir(this.crossSignalsDir, { recursive: true });
    await mkdir(path.join(this.dir, "staging"), { recursive: true });
    await mkdir(path.join(this.dir, "kpis"), { recursive: true });
    await mkdir(path.join(this.dir, "calendar"), { recursive: true });
    await mkdir(path.join(this.dir, "content-calendar"), { recursive: true });

    // Bootstrap files if missing.
    await this.ensureFile(
      this.prioritiesPath,
      [
        "# Priorities",
        "",
        "This is the shared priority stack. Agents should read this before acting.",
        "",
        "## Current",
        "- (empty)",
        "",
        "## Notes",
        "- (empty)",
        "",
      ].join("\n"),
    );
    await this.ensureFile(
      this.prioritiesInboxPath,
      [
        "# Priorities Inbox",
        "",
        "Append-only inbox. Curator merges into priorities.md.",
        "",
      ].join("\n"),
    );
    await this.ensureFile(this.feedbackInboxPath, "");
  }

  private async ensureFile(fp: string, content: string): Promise<void> {
    try {
      await stat(fp);
    } catch {
      await writeFile(fp, content, "utf-8");
    }
  }

  async readPriorities(): Promise<string> {
    try {
      return await readFile(this.prioritiesPath, "utf-8");
    } catch {
      return "";
    }
  }

  async readLatestRoundtable(): Promise<string> {
    try {
      const files = (await readdir(this.roundtableDir))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      const fp = files[0] ? path.join(this.roundtableDir, files[0]) : null;
      if (!fp) return "";
      return await readFile(fp, "utf-8");
    } catch {
      return "";
    }
  }

  async writeAgentOutput(opts: {
    agentId: string;
    title: string;
    content: string;
    createdAt?: Date;
  }): Promise<string> {
    const createdAt = opts.createdAt ?? new Date();
    const date = ymd(createdAt);
    const time = createdAt.toISOString().slice(11, 19).replace(/:/g, "");
    const slug = safeSlug(opts.title);

    const dir = path.join(this.outputsDir, opts.agentId, date);
    await mkdir(dir, { recursive: true });
    const fp = path.join(dir, `${time}-${slug}.md`);

    const body =
      `---\n` +
      `kind: agent_output\n` +
      `agent: ${opts.agentId}\n` +
      `createdAt: ${createdAt.toISOString()}\n` +
      `title: ${opts.title.replace(/\n/g, " ").slice(0, 200)}\n` +
      `---\n\n` +
      opts.content.trimEnd() +
      "\n";

    await writeFile(fp, body, "utf-8");
    return fp;
  }

  async appendFeedback(entry: SharedFeedbackEntry): Promise<void> {
    const parsed = SharedFeedbackEntrySchema.parse(entry);
    await appendFile(this.feedbackInboxPath, JSON.stringify(parsed) + "\n", "utf-8");
  }

  async appendPrioritiesInbox(opts: { agentId: string; text: string }): Promise<void> {
    const stamp = new Date().toISOString();
    const lines = [
      "",
      `## ${stamp} (${opts.agentId})`,
      "",
      opts.text.trimEnd(),
      "",
    ].join("\n");
    await appendFile(this.prioritiesInboxPath, lines, "utf-8");
  }

  async curateDaily(opts: { date?: string; maxChars?: number }): Promise<SharedDailyCurationResult> {
    const date = opts.date ?? ymd(new Date());
    const maxChars = Math.max(2_000, opts.maxChars ?? 20_000);

    // Collect outputs for the day (best-effort).
    const outputs: Array<{ agent: string; path: string; title: string; raw: string }> = [];
    try {
      const agents = await readdir(this.outputsDir, { withFileTypes: true });
      for (const a of agents) {
        if (!a.isDirectory()) continue;
        const dayDir = path.join(this.outputsDir, a.name, date);
        try {
          const files = (await readdir(dayDir)).filter((f) => f.endsWith(".md")).sort();
          for (const f of files) {
            const p = path.join(dayDir, f);
            const raw = await readFile(p, "utf-8");
            const title = (raw.match(/^title:\s*(.+)$/m)?.[1] ?? f).trim();
            outputs.push({ agent: a.name, path: p, title, raw });
          }
        } catch {
          // no outputs for this agent/date
        }
      }
    } catch {
      // ignore
    }

    // Collect feedback entries for the day.
    const feedback: SharedFeedbackEntry[] = [];
    try {
      const raw = await readFile(this.feedbackInboxPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const parsed = SharedFeedbackEntrySchema.safeParse(obj);
          if (!parsed.success) continue;
          if (String(parsed.data.date).startsWith(date)) feedback.push(parsed.data);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    const sources: SharedCrossSignalSource[] = outputs.map((output) => ({
      agent: output.agent,
      path: output.path,
      title: output.title,
      topics: extractTopicTokens(`${output.title}\n${output.raw}`),
    }));

    const overlapMap = new Map<string, { agents: Set<string>; sourcePaths: Set<string> }>();
    for (const source of sources) {
      for (const token of source.topics) {
        const existing = overlapMap.get(token);
        if (existing) {
          existing.agents.add(source.agent);
          existing.sourcePaths.add(source.path);
        } else {
          overlapMap.set(token, {
            agents: new Set([source.agent]),
            sourcePaths: new Set([source.path]),
          });
        }
      }
    }

    const overlaps: SharedCrossSignalOverlap[] = [...overlapMap.entries()]
      .map(([token, v]) => ({
        token,
        agents: [...v.agents].sort(),
        sourcePaths: [...v.sourcePaths].sort(),
        agentCount: v.agents.size,
      }))
      .filter((entry) => entry.agentCount >= 2)
      .sort((a, b) => b.agentCount - a.agentCount || a.token.localeCompare(b.token));

    const feedbackByDecision: SharedCrossSignalReport["feedbackByDecision"] = {
      approved: 0,
      approved_with_feedback: 0,
      rejected: 0,
    };
    for (const entry of feedback) {
      feedbackByDecision[entry.decision] += 1;
    }

    const crossSignalReport: SharedCrossSignalReport = {
      date,
      generatedAt: new Date().toISOString(),
      sourceCount: sources.length,
      feedbackCount: feedback.length,
      feedbackByDecision,
      sources,
      overlaps,
    };
    const crossSignalsPath = path.join(this.crossSignalsDir, `${date}.json`);
    await writeFile(crossSignalsPath, `${JSON.stringify(crossSignalReport, null, 2)}\n`, "utf-8");

    const overlapBullets = overlaps.length === 0
      ? ["- No multi-agent topic overlap detected."]
      : overlaps.slice(0, 8).map((entry) => `- \`${entry.token}\` (${entry.agentCount} agents: ${entry.agents.join(", ")})`);

    const md: string[] = [
      `# Roundtable — ${date}`,
      "",
      "## Notable Agent Outputs",
      ...(sources.length === 0 ? ["- (none)"] : sources.map((o) => `- ${o.title} (${o.path})`)),
      "",
      "## Feedback (Approve/Reject)",
      ...(feedback.length === 0
        ? ["- (none)"]
        : feedback.map((f) => `- [${f.agent}] ${f.decision}: ${f.reason}`)),
      "",
      "## Cross-Signals",
      `- Source outputs analyzed: ${sources.length}`,
      `- Feedback entries analyzed: ${feedback.length}`,
      `- Decision totals: approved=${feedbackByDecision.approved}, approved_with_feedback=${feedbackByDecision.approved_with_feedback}, rejected=${feedbackByDecision.rejected}`,
      `- Cross-signals file: ${crossSignalsPath}`,
      ...overlapBullets,
      "",
    ];

    const out = md.join("\n");
    const trimmed = out.length > maxChars ? out.slice(0, maxChars) + "\n\n...(trimmed)\n" : out;

    const roundtablePath = path.join(this.roundtableDir, `${date}.md`);
    await writeFile(roundtablePath, trimmed, "utf-8");

    log.info(`shared-context curated daily roundtable: ${roundtablePath}`);
    return {
      date,
      roundtablePath,
      crossSignalsPath,
      overlapCount: overlaps.length,
    };
  }
}
