import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { log } from "./logger.js";
import type { HourlySummary, TranscriptEntry, PluginConfig } from "./types.js";

// Schema for LLM summary output
const HourlySummarySchema = z.object({
  bullets: z
    .array(z.string())
    .describe("3-5 bullet points summarizing the hour's activity"),
});

type HourlySummaryResult = z.infer<typeof HourlySummarySchema>;

export class HourlySummarizer {
  private summariesDir: string;
  private config: PluginConfig;
  private client: OpenAI | null;

  constructor(config: PluginConfig) {
    this.config = config;
    this.summariesDir = path.join(config.memoryDir, "summaries", "hourly");

    // Initialize OpenAI client same way extraction.ts does
    if (config.openaiApiKey) {
      this.client = new OpenAI({ apiKey: config.openaiApiKey });
    } else {
      this.client = null;
      log.warn("no OpenAI API key — hourly summarization disabled");
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.summariesDir, { recursive: true });
    log.info("hourly summarizer initialized");
  }

  // Generate summary for a specific hour and session
  async generateSummary(
    sessionKey: string,
    hourStart: Date,
    entries: TranscriptEntry[]
  ): Promise<HourlySummary | null> {
    if (entries.length === 0) return null;

    if (!this.client) {
      log.warn("summary generation skipped — no OpenAI API key");
      return null;
    }

    // Format entries for the LLM
    const conversation = entries
      .map((e) => `[${e.role}] ${e.content}`)
      .join("\n\n");

    const hourIso = hourStart.toISOString();
    const traceId = crypto.randomUUID();
    const startTime = Date.now();

    try {
      const response = await this.client.responses.parse({
        model: this.config.summaryModel || this.config.model,
        instructions: `You are a conversation summarization system. Summarize the following conversation transcript into 3-5 concise bullet points.

Guidelines:
- Focus on what was accomplished, decided, or discussed
- Include specific topics, projects, or entities mentioned
- Note any significant user requests or agent actions
- Keep bullets brief but informative (1-2 sentences each)
- Skip trivial greetings or meta-conversation
- Use present tense for ongoing work, past for completed items`,
        input: conversation,
        text: {
          format: zodTextFormat(HourlySummarySchema, "hourly_summary"),
        },
      });

      const durationMs = Date.now() - startTime;
      const usage = (response as any).usage;

      log.debug(
        `generated hourly summary for ${sessionKey} at ${hourIso} in ${durationMs}ms`,
        usage
          ? `(tokens: ${usage.input_tokens}/${usage.output_tokens})`
          : ""
      );

      if (response.output_parsed) {
        const result = response.output_parsed as HourlySummaryResult;
        return {
          hour: hourIso,
          sessionKey,
          bullets: result.bullets,
          turnCount: entries.length,
          generatedAt: new Date().toISOString(),
        };
      }

      log.warn("summary generation returned no parsed output");
      return null;
    } catch (err) {
      log.error("summary generation failed", err);
      return null;
    }
  }

  // Save summary to file
  async saveSummary(summary: HourlySummary): Promise<void> {
    const sessionDir = path.join(this.summariesDir, summary.sessionKey);
    await mkdir(sessionDir, { recursive: true });

    // Format date as YYYY-MM-DD for the filename
    const dateStr = summary.hour.slice(0, 10);
    const filePath = path.join(sessionDir, `${dateStr}.md`);

    // Format hour as HH:00 for display
    const hourStr = summary.hour.slice(11, 13);

    // Build markdown content
    const lines: string[] = [];

    // Check if file exists to append or create
    let existingContent = "";
    try {
      existingContent = await readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist yet, will create new
    }

    // Check if this hour already exists (idempotent)
    const hourHeader = `## ${hourStr}:00`;
    if (existingContent.includes(hourHeader)) {
      // Replace existing hour section
      const beforeHour = existingContent.split(hourHeader)[0];
      const afterMatch = existingContent.split(hourHeader)[1];
      const afterHour = afterMatch ? afterMatch.split("\n## ")[1] : undefined;

      const newSection = this.formatHourSection(summary, hourHeader);

      if (afterHour) {
        existingContent = beforeHour + newSection + "\n## " + afterHour;
      } else {
        existingContent = beforeHour + newSection;
      }

      await writeFile(filePath, existingContent, "utf-8");
      log.debug(`updated hourly summary for ${summary.sessionKey} at ${hourStr}:00`);
    } else {
      // Append new hour section
      const newSection = this.formatHourSection(summary, hourHeader);

      if (existingContent) {
        // Add to existing file
        await writeFile(filePath, existingContent.trimEnd() + "\n\n" + newSection, "utf-8");
      } else {
        // Create new file with header
        const header = `# Hourly Summaries — ${dateStr}\n\n*Session: ${summary.sessionKey}*\n`;
        await writeFile(filePath, header + "\n" + newSection, "utf-8");
      }
      log.debug(`saved hourly summary for ${summary.sessionKey} at ${hourStr}:00`);
    }
  }

  private formatHourSection(summary: HourlySummary, hourHeader: string): string {
    const lines: string[] = [hourHeader, ""];
    for (const bullet of summary.bullets) {
      lines.push(`- ${bullet}`);
    }
    lines.push(`  *(${summary.turnCount} turns)*`);
    lines.push("");
    return lines.join("\n");
  }

  // Read recent summaries for recall injection
  async readRecent(sessionKey: string, hours: number): Promise<HourlySummary[]> {
    const sessionDir = path.join(this.summariesDir, sessionKey);

    try {
      const files = await readdir(sessionDir);
      const mdFiles = files.filter((f) => f.endsWith(".md"));

      const summaries: HourlySummary[] = [];
      const cutoffTime = Date.now() - hours * 60 * 60 * 1000;

      for (const file of mdFiles) {
        const filePath = path.join(sessionDir, file);
        const content = await readFile(filePath, "utf-8");

        // Parse the markdown file
        const parsed = this.parseSummaryFile(content, sessionKey, file);
        summaries.push(...parsed);
      }

      // Filter to recent hours and sort by hour descending
      return summaries
        .filter((s) => new Date(s.hour).getTime() >= cutoffTime)
        .sort((a, b) => new Date(b.hour).getTime() - new Date(a.hour).getTime());
    } catch {
      // Directory doesn't exist or error reading
      return [];
    }
  }

  private parseSummaryFile(
    content: string,
    sessionKey: string,
    filename: string
  ): HourlySummary[] {
    const summaries: HourlySummary[] = [];

    // Extract date from filename (YYYY-MM-DD.md)
    const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dateMatch) return summaries;
    const dateStr = dateMatch[1];

    // Split by hour sections
    const hourSections = content.split(/\n## (\d{2}):00\n/);

    // First element is the header, skip it
    for (let i = 1; i < hourSections.length; i += 2) {
      const hourStr = hourSections[i];
      const sectionContent = hourSections[i + 1] || "";

      // Parse bullets
      const bullets: string[] = [];
      const lines = sectionContent.split("\n");
      let turnCount = 0;

      for (const line of lines) {
        const bulletMatch = line.match(/^- (.+)$/);
        if (bulletMatch) {
          bullets.push(bulletMatch[1]);
        }
        const turnMatch = line.match(/\((\d+) turns?\)/);
        if (turnMatch) {
          turnCount = parseInt(turnMatch[1], 10);
        }
      }

      if (bullets.length > 0) {
        summaries.push({
          hour: `${dateStr}T${hourStr}:00:00.000Z`,
          sessionKey,
          bullets,
          turnCount,
          generatedAt: "", // Not stored in file, not needed for recall
        });
      }
    }

    return summaries;
  }

  // Format summaries for recall injection
  formatForRecall(summaries: HourlySummary[], maxCount: number): string {
    if (summaries.length === 0) return "";

    const limited = summaries.slice(0, maxCount);
    const lines: string[] = [`## Recent Activity (last ${limited.length} hours)`];

    for (const summary of limited) {
      const hourStr = summary.hour.slice(11, 16); // HH:MM
      for (const bullet of summary.bullets) {
        lines.push(`- ${hourStr}: ${bullet}`);
      }
    }

    return lines.join("\n");
  }

  // Main entry point for cron job
  async runHourly(): Promise<void> {
    log.debug("running hourly summary generation");

    // Get active sessions from transcript
    const sessions = await this.getActiveSessions();

    for (const sessionKey of sessions) {
      // Calculate the hour we want to summarize (previous hour)
      const now = new Date();
      const hourStart = new Date(now.getTime() - 60 * 60 * 1000);
      hourStart.setMinutes(0, 0, 0);
      const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);

      // Get entries for this session in the target hour
      const entries = await this.getTranscriptEntries(sessionKey, hourStart, hourEnd);

      if (entries.length === 0) {
        log.debug(`no transcript entries for ${sessionKey} at ${hourStart.toISOString()}`);
        continue;
      }

      // Generate and save summary
      const summary = await this.generateSummary(sessionKey, hourStart, entries);
      if (summary) {
        await this.saveSummary(summary);
        log.info(`generated hourly summary for ${sessionKey} (${entries.length} turns)`);
      }
    }
  }

  // Get list of active sessions from transcript directory
  private async getActiveSessions(): Promise<string[]> {
    const transcriptDir = path.join(this.config.memoryDir, "transcripts");

    try {
      const entries = await readdir(transcriptDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  // Get transcript entries for a session within a time range
  private async getTranscriptEntries(
    sessionKey: string,
    startTime: Date,
    endTime: Date
  ): Promise<TranscriptEntry[]> {
    const parts = sessionKey.split(":");
    let channelType = "other";
    let channelId = "default";

    if (parts.length >= 3) {
      channelType = parts[2];
      if (channelType === "main") {
        channelId = "default";
      } else if (channelType === "discord" && parts.length >= 5 && parts[3] === "channel") {
        channelId = parts[4];
      } else if (channelType === "slack" && parts.length >= 5 && parts[3] === "channel") {
        channelId = parts[4];
      } else if (channelType === "cron" && parts.length >= 4) {
        channelId = parts[3];
      } else if (parts.length >= 4) {
        channelId = parts[3];
      }
    }

    const transcriptDir = path.join(this.config.memoryDir, "transcripts", channelType, channelId);

    try {
      // Read all daily transcript files in the directory
      const files = await readdir(transcriptDir);
      const entries: TranscriptEntry[] = [];

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const transcriptPath = path.join(transcriptDir, file);
        try {
          const content = await readFile(transcriptPath, "utf-8");
          const lines = content.trim().split("\n");

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line) as TranscriptEntry;
              const entryTime = new Date(entry.timestamp).getTime();

              if (entryTime >= startTime.getTime() && entryTime < endTime.getTime()) {
                entries.push(entry);
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      return entries;
    } catch {
      return [];
    }
  }
}
