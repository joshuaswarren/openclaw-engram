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

function stripYamlFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const closing = text.indexOf("\n---\n", 4);
  if (closing === -1) return text;
  return text.slice(closing + 5);
}

function semanticRoot(token: string): string {
  let root = token.toLowerCase();
  if (root.endsWith("ization") && root.length > 8) {
    return `${root.slice(0, -7)}ize`;
  }
  if (root.endsWith("isation") && root.length > 8) {
    return `${root.slice(0, -7)}ise`;
  }
  const suffixes = [
    "izations",
    "ization",
    "ations",
    "ation",
    "ments",
    "ment",
    "ingly",
    "edly",
    "ings",
    "ing",
    "ers",
    "er",
    "ies",
    "ied",
    "ions",
    "ion",
    "es",
    "ed",
    "s",
  ];
  for (const suffix of suffixes) {
    if (root.length > suffix.length + 3 && root.endsWith(suffix)) {
      root = root.slice(0, -suffix.length);
      break;
    }
  }
  return root;
}

function mergeOverlaps(
  base: SharedCrossSignalOverlap[],
  extra: SharedCrossSignalOverlap[],
): SharedCrossSignalOverlap[] {
  const merged = new Map<string, { agents: Set<string>; sourcePaths: Set<string> }>();
  for (const entry of [...base, ...extra]) {
    const existing = merged.get(entry.token);
    if (existing) {
      for (const agent of entry.agents) existing.agents.add(agent);
      for (const sourcePath of entry.sourcePaths) existing.sourcePaths.add(sourcePath);
    } else {
      merged.set(entry.token, {
        agents: new Set(entry.agents),
        sourcePaths: new Set(entry.sourcePaths),
      });
    }
  }
  return [...merged.entries()]
    .map(([token, value]) => ({
      token,
      agents: [...value.agents].sort(),
      sourcePaths: [...value.sourcePaths].sort(),
      agentCount: value.agents.size,
    }))
    .filter((entry) => entry.agentCount >= 2)
    .sort((a, b) => b.agentCount - a.agentCount || a.token.localeCompare(b.token));
}

function computeSemanticOverlapCandidates(
  sources: SharedCrossSignalSource[],
  maxCandidates: number,
): { overlaps: SharedCrossSignalOverlap[]; candidateCount: number } {
  const tokenRows: Array<{ token: string; agent: string; path: string }> = [];
  for (const source of sources) {
    for (const token of source.topics) {
      tokenRows.push({ token, agent: source.agent, path: source.path });
      if (tokenRows.length >= maxCandidates) break;
    }
    if (tokenRows.length >= maxCandidates) break;
  }

  const byRoot = new Map<string, Map<string, { agents: Set<string>; paths: Set<string> }>>();
  for (const row of tokenRows) {
    const root = semanticRoot(row.token);
    if (root.length < 4) continue;
    const rootGroup = byRoot.get(root) ?? new Map<string, { agents: Set<string>; paths: Set<string> }>();
    const tokenGroup = rootGroup.get(row.token) ?? { agents: new Set<string>(), paths: new Set<string>() };
    tokenGroup.agents.add(row.agent);
    tokenGroup.paths.add(row.path);
    rootGroup.set(row.token, tokenGroup);
    byRoot.set(root, rootGroup);
  }

  const overlaps: SharedCrossSignalOverlap[] = [];
  for (const [root, tokenMap] of byRoot.entries()) {
    if (tokenMap.size < 2) continue;
    const agents = new Set<string>();
    const sourcePaths = new Set<string>();
    for (const value of tokenMap.values()) {
      for (const agent of value.agents) agents.add(agent);
      for (const sourcePath of value.paths) sourcePaths.add(sourcePath);
    }
    if (agents.size < 2) continue;
    overlaps.push({
      token: `semantic:${root}`,
      agents: [...agents].sort(),
      sourcePaths: [...sourcePaths].sort(),
      agentCount: agents.size,
    });
  }

  overlaps.sort((a, b) => b.agentCount - a.agentCount || a.token.localeCompare(b.token));
  return {
    overlaps,
    candidateCount: tokenRows.length,
  };
}

async function computeSemanticOverlapsWithTimeout(
  sources: SharedCrossSignalSource[],
  timeoutMs: number,
  maxCandidates: number,
): Promise<{ overlaps: SharedCrossSignalOverlap[]; candidateCount: number; timedOut: boolean }> {
  const safeTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const safeMaxCandidates = Math.max(0, Math.floor(maxCandidates));
  if (safeMaxCandidates === 0 || sources.length === 0) {
    return { overlaps: [], candidateCount: 0, timedOut: false };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), safeTimeoutMs);
  });
  const computePromise = (async () => {
    // Keep an explicit async boundary so timeout behavior is deterministic under tests.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return computeSemanticOverlapCandidates(sources, safeMaxCandidates);
  })();

  const raced = await Promise.race([computePromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (raced === null) return { overlaps: [], candidateCount: 0, timedOut: true };
  return { overlaps: raced.overlaps, candidateCount: raced.candidateCount, timedOut: false };
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
  semantic: {
    enabled: boolean;
    applied: boolean;
    timedOut: boolean;
    candidateCount: number;
    maxCandidates: number;
    addedOverlapCount: number;
  };
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

    const sources: SharedCrossSignalSource[] = outputs.map((output) => {
      const body = stripYamlFrontmatter(output.raw);
      return {
        agent: output.agent,
        path: output.path,
        title: output.title,
        topics: extractTopicTokens(`${output.title}\n${body}`),
      };
    });

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

    const semanticEnabled =
      this.config.sharedCrossSignalSemanticEnabled === true
      || this.config.crossSignalsSemanticEnabled === true;
    const semanticTimeoutMs =
      this.config.sharedCrossSignalSemanticTimeoutMs
      ?? this.config.crossSignalsSemanticTimeoutMs
      ?? 4000;
    const semanticMaxCandidates = this.config.sharedCrossSignalSemanticMaxCandidates ?? 120;
    let semanticApplied = false;
    let semanticTimedOut = false;
    let semanticCandidateCount = 0;
    let semanticAddedOverlapCount = 0;
    let mergedOverlaps = overlaps;
    if (semanticEnabled) {
      try {
        const semanticResult = await computeSemanticOverlapsWithTimeout(
          sources,
          semanticTimeoutMs,
          semanticMaxCandidates,
        );
        semanticTimedOut = semanticResult.timedOut;
        semanticCandidateCount = semanticResult.candidateCount;
        if (!semanticResult.timedOut && semanticResult.overlaps.length > 0) {
          mergedOverlaps = mergeOverlaps(overlaps, semanticResult.overlaps);
          semanticAddedOverlapCount = Math.max(0, mergedOverlaps.length - overlaps.length);
          semanticApplied = semanticAddedOverlapCount > 0;
        }
      } catch (err) {
        log.warn(`shared-context semantic cross-signals failed; fail-open to deterministic output: ${err}`);
      }
    }

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
      overlaps: mergedOverlaps,
      semantic: {
        enabled: semanticEnabled,
        applied: semanticApplied,
        timedOut: semanticTimedOut,
        candidateCount: semanticCandidateCount,
        maxCandidates: Math.max(0, Math.floor(semanticMaxCandidates)),
        addedOverlapCount: semanticAddedOverlapCount,
      },
    };
    const crossSignalsPath = path.join(this.crossSignalsDir, `${date}.json`);
    await writeFile(crossSignalsPath, `${JSON.stringify(crossSignalReport, null, 2)}\n`, "utf-8");

    const overlapBullets = mergedOverlaps.length === 0
      ? ["- No multi-agent topic overlap detected."]
      : mergedOverlaps.slice(0, 8).map((entry) => `- \`${entry.token}\` (${entry.agentCount} agents: ${entry.agents.join(", ")})`);

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
      `- Semantic enhancer: ${semanticEnabled ? (semanticTimedOut ? "enabled (timed out, fail-open)" : semanticApplied ? "enabled (applied)" : "enabled (no additional overlaps)") : "disabled"}`,
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
      overlapCount: mergedOverlaps.length,
    };
  }
}
