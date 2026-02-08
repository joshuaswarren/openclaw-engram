import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import type { TranscriptEntry, Checkpoint, PluginConfig } from "./types.js";

/**
 * Manages conversation transcript storage, checkpointing, and recall formatting.
 *
 * Transcripts are stored as JSONL files in a hierarchical structure:
 *   transcripts/{channelType}/{channelId}.jsonl
 *
 * Channel types are extracted from sessionKey (discord, slack, cron, main, etc.)
 * Checkpoints are used to preserve conversation context across compaction events.
 */
export class TranscriptManager {
  private transcriptsDir: string;
  private checkpointPath: string;
  private stateDir: string;
  private config: PluginConfig;

  /** Default checkpoint TTL in hours */
  private static readonly DEFAULT_CHECKPOINT_TTL_HOURS = 24;
  /** Approximate characters per token for rough estimation */
  private static readonly CHARS_PER_TOKEN = 4;

  constructor(config: PluginConfig) {
    this.config = config;
    this.transcriptsDir = path.join(config.memoryDir, "transcripts");
    this.stateDir = path.join(config.memoryDir, "state");
    this.checkpointPath = path.join(this.stateDir, "checkpoint.json");
  }

  /**
   * Parse a sessionKey to extract channel type and ID.
   *
   * SessionKey patterns:
   *   - agent:generalist:main → type="main", id="default"
   *   - agent:generalist:discord:channel:1468425700242620516 → type="discord", id="1468425700242620516"
   *   - agent:generalist:cron:db61e2ac-... → type="cron", id="db61e2ac-..."
   *   - agent:generalist:slack:channel:C123456 → type="slack", id="C123456"
   *
   * @returns Object with dir (channel type/channel id) and file (YYYY-MM-DD.jsonl)
   */
  getTranscriptPath(sessionKey: string): { dir: string; file: string } {
    const parts = sessionKey.split(":");

    // Default fallback
    let channelType = "other";
    let channelId = "default";

    if (parts.length >= 3) {
      // parts[0] = "agent", parts[1] = agent name, parts[2] = channel type
      channelType = parts[2];

      // Extract channel ID based on pattern
      if (channelType === "main") {
        channelId = "default";
      } else if (channelType === "discord" && parts.length >= 5 && parts[3] === "channel") {
        channelId = parts[4];
      } else if (channelType === "slack" && parts.length >= 5 && parts[3] === "channel") {
        channelId = parts[4];
      } else if (channelType === "cron" && parts.length >= 4) {
        channelId = parts[3];
      } else if (parts.length >= 4) {
        // For other types, use the 4th part as ID if available
        channelId = parts[3];
      }
    }

    // Daily rotation: transcripts/{channelType}/{channelId}/YYYY-MM-DD.jsonl
    const today = new Date().toISOString().slice(0, 10);
    return {
      dir: path.join(channelType, channelId),
      file: `${today}.jsonl`,
    };
  }

  /**
   * Initialize the transcript manager by ensuring directories exist.
   */
  async initialize(): Promise<void> {
    await mkdir(this.transcriptsDir, { recursive: true });
    await mkdir(this.stateDir, { recursive: true });
    log.info("transcript manager initialized");
  }

  /**
   * Check if a file is a legacy flat transcript file (YYYY-MM-DD.jsonl format).
   */
  private isLegacyTranscriptFile(filename: string): boolean {
    return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(filename);
  }

  /**
   * Append a turn to the appropriate transcript file.
   * Files are stored hierarchically: transcripts/{channelType}/{channelId}.jsonl
   *
   * Skips channel types in config.transcriptSkipChannelTypes (e.g., "cron").
   */
  async append(entry: TranscriptEntry): Promise<void> {
    try {
      const { dir, file } = this.getTranscriptPath(entry.sessionKey);

      // Skip if this channel type is in the skip list
      if (this.config.transcriptSkipChannelTypes.includes(dir)) {
        return;
      }

      const channelDir = path.join(this.transcriptsDir, dir);
      const filePath = path.join(channelDir, file);

      // Ensure channel directory exists
      await mkdir(channelDir, { recursive: true });

      const line = JSON.stringify(entry) + "\n";
      await appendFile(filePath, line, "utf-8");
      log.debug(`appended transcript entry for ${entry.sessionKey}: ${entry.turnId}`);
    } catch (err) {
      log.error("failed to append transcript entry:", err);
      throw err;
    }
  }

  /**
   * Get all transcript files from the hierarchical directory structure.
   * Recursively finds all .jsonl files in transcripts/{channelType}/{channelId}/ subdirectories.
   */
  private async getAllTranscriptFiles(): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(this.transcriptsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // This is a channel type directory (discord, slack, cron, main, etc.)
          const channelTypeDir = path.join(this.transcriptsDir, entry.name);
          try {
            const channelTypeEntries = await readdir(channelTypeDir, { withFileTypes: true });

            for (const channelTypeEntry of channelTypeEntries) {
              if (channelTypeEntry.isDirectory()) {
                // This is a channel ID directory - contains daily transcript files
                const channelDir = path.join(channelTypeDir, channelTypeEntry.name);
                try {
                  const channelFiles = await readdir(channelDir);
                  for (const file of channelFiles) {
                    if (file.endsWith(".jsonl")) {
                      files.push(path.join(entry.name, channelTypeEntry.name, file));
                    }
                  }
                } catch {
                  // Skip unreadable directories
                }
              } else if (channelTypeEntry.isFile() && channelTypeEntry.name.endsWith(".jsonl")) {
                // Legacy: channel type dir contains .jsonl files directly
                files.push(path.join(entry.name, channelTypeEntry.name));
              }
            }
          } catch {
            // Skip unreadable directories
          }
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          // Legacy flat file - still include for backward compatibility
          files.push(entry.name);
        }
      }
    } catch {
      // Directory doesn't exist or is unreadable
    }

    return files;
  }

  /**
   * Read transcript entries for a date range.
   * Returns entries within the time range, optionally filtered by sessionKey.
   * Reads from all channel subdirectories in the hierarchical structure.
   */
  async readRange(startTime: string, endTime: string, sessionKey?: string): Promise<TranscriptEntry[]> {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const entries: TranscriptEntry[] = [];

    try {
      // Get all transcript files from the hierarchical structure
      const transcriptFiles = await this.getAllTranscriptFiles();

      // Read each relevant file
      for (const relativePath of transcriptFiles) {
        const filePath = path.join(this.transcriptsDir, relativePath);
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.trim().split("\n").filter(Boolean);

          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as TranscriptEntry;
              const entryTime = new Date(entry.timestamp);

              // Check if entry is within time range
              if (entryTime >= start && entryTime <= end) {
                // Filter by sessionKey if provided
                if (!sessionKey || entry.sessionKey === sessionKey) {
                  entries.push(entry);
                }
              }
            } catch {
              // Skip malformed lines
              log.debug(`skipped malformed transcript line in ${relativePath}`);
            }
          }
        } catch {
          // File doesn't exist or is unreadable - skip
        }
      }

      // Sort by timestamp
      entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      log.debug(`read ${entries.length} transcript entries from ${transcriptFiles.length} file(s)`);
      return entries;
    } catch (err) {
      log.error("failed to read transcript range:", err);
      return [];
    }
  }

  /**
   * Read the last N hours of transcript.
   */
  async readRecent(hours: number, sessionKey?: string): Promise<TranscriptEntry[]> {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    return this.readRange(start.toISOString(), end.toISOString(), sessionKey);
  }

  /**
   * Cleanup old transcript entries that are older than retentionDays.
   * For hierarchical structure, reads each file and rewrites without old entries.
   * Legacy flat files are deleted if their date is older than retentionDays.
   * Returns the number of files processed (cleaned or deleted).
   */
  async cleanup(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) {
      log.warn("cleanup called with invalid retentionDays:", retentionDays);
      return 0;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    cutoff.setHours(0, 0, 0, 0);

    let processed = 0;

    try {
      const entries = await readdir(this.transcriptsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // This is a channel type directory (discord, slack, cron, main, etc.)
          const channelTypeDir = path.join(this.transcriptsDir, entry.name);
          try {
            const channelTypeEntries = await readdir(channelTypeDir, { withFileTypes: true });

            for (const channelTypeEntry of channelTypeEntries) {
              if (channelTypeEntry.isDirectory()) {
                // This is a channel ID directory - contains daily transcript files
                const channelDir = path.join(channelTypeDir, channelTypeEntry.name);
                try {
                  const channelFiles = await readdir(channelDir);
                  for (const file of channelFiles) {
                    if (!file.endsWith(".jsonl")) continue;

                    const filePath = path.join(channelDir, file);

                    // Check if file is a daily transcript file (YYYY-MM-DD.jsonl)
                    if (this.isLegacyTranscriptFile(file)) {
                      const dateStr = file.slice(0, 10);
                      const fileDate = new Date(dateStr);

                      if (!isNaN(fileDate.getTime()) && fileDate < cutoff) {
                        try {
                          await unlink(filePath);
                          processed++;
                          log.debug(`deleted old daily transcript file: ${entry.name}/${channelTypeEntry.name}/${file}`);
                        } catch (err) {
                          log.error(`failed to delete transcript file ${filePath}:`, err);
                        }
                      }
                    } else {
                      // Legacy file in new structure - clean up old entries
                      const cleaned = await this.cleanupTranscriptFile(filePath, cutoff);
                      if (cleaned) {
                        processed++;
                      }
                    }
                  }
                } catch (err) {
                  log.debug(`failed to process channel directory ${entry.name}/${channelTypeEntry.name}:`, err);
                }
              } else if (channelTypeEntry.isFile() && channelTypeEntry.name.endsWith(".jsonl")) {
                // Legacy: channel type dir contains .jsonl files directly
                const filePath = path.join(channelTypeDir, channelTypeEntry.name);
                const cleaned = await this.cleanupTranscriptFile(filePath, cutoff);
                if (cleaned) {
                  processed++;
                }
              }
            }
          } catch (err) {
            log.debug(`failed to process channel type directory ${entry.name}:`, err);
          }
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          // Handle legacy flat files - delete if older than retentionDays
          if (this.isLegacyTranscriptFile(entry.name)) {
            const dateStr = entry.name.slice(0, 10);
            const fileDate = new Date(dateStr);

            if (!isNaN(fileDate.getTime()) && fileDate < cutoff) {
              const filePath = path.join(this.transcriptsDir, entry.name);
              try {
                await unlink(filePath);
                processed++;
                log.debug(`deleted old legacy transcript file: ${entry.name}`);
              } catch (err) {
                log.error(`failed to delete legacy transcript file ${entry.name}:`, err);
              }
            }
          }
        }
      }

      if (processed > 0) {
        log.info(`cleaned up ${processed} transcript file(s) older than ${retentionDays} days`);
      }

      return processed;
    } catch (err) {
      log.error("failed to cleanup old transcripts:", err);
      return 0;
    }
  }

  /**
   * Clean up old entries from a single transcript file.
   * Reads the file, filters out entries older than cutoff, and rewrites if needed.
   * Returns true if the file was processed (cleaned or deleted).
   */
  private async cleanupTranscriptFile(filePath: string, cutoff: Date): Promise<boolean> {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      const validLines: string[] = [];
      let hasOldEntries = false;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as TranscriptEntry;
          const entryTime = new Date(entry.timestamp);

          if (entryTime >= cutoff) {
            validLines.push(line);
          } else {
            hasOldEntries = true;
          }
        } catch {
          // Keep malformed lines to avoid data loss
          validLines.push(line);
        }
      }

      if (validLines.length === 0) {
        // No valid entries left, delete the file
        try {
          await unlink(filePath);
          log.debug(`deleted empty transcript file: ${filePath}`);
          return true;
        } catch (err) {
          log.error(`failed to delete empty transcript file ${filePath}:`, err);
          return false;
        }
      }

      if (hasOldEntries) {
        // Rewrite file without old entries
        await writeFile(filePath, validLines.join("\n") + "\n", "utf-8");
        log.debug(`cleaned old entries from transcript file: ${filePath}`);
        return true;
      }

      // No old entries found, no action needed
      return false;
    } catch (err) {
      // File doesn't exist or is unreadable
      return false;
    }
  }

  /**
   * Save a checkpoint to preserve conversation context.
   * Called when compaction is detected.
   */
  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    try {
      await writeFile(this.checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");
      log.info(`saved checkpoint for session ${checkpoint.sessionKey} with ${checkpoint.turns.length} turn(s)`);
    } catch (err) {
      log.error("failed to save checkpoint:", err);
      throw err;
    }
  }

  /**
   * Load a checkpoint if one exists and is not expired.
   * Returns null if no checkpoint exists or if it has expired.
   */
  async loadCheckpoint(sessionKey?: string): Promise<Checkpoint | null> {
    try {
      const raw = await readFile(this.checkpointPath, "utf-8");
      const checkpoint = JSON.parse(raw) as Checkpoint;

      // Validate checkpoint structure
      if (!checkpoint.sessionKey || !checkpoint.capturedAt || !checkpoint.ttl || !Array.isArray(checkpoint.turns)) {
        log.warn("checkpoint file has invalid structure");
        return null;
      }

      // Check if checkpoint is for the requested session (if specified)
      if (sessionKey && checkpoint.sessionKey !== sessionKey) {
        log.debug(`checkpoint session mismatch: ${checkpoint.sessionKey} vs ${sessionKey}`);
        return null;
      }

      // Check if checkpoint has expired
      const ttl = new Date(checkpoint.ttl);
      if (isNaN(ttl.getTime())) {
        log.warn("checkpoint has invalid TTL format");
        return null;
      }

      if (ttl < new Date()) {
        log.info(`checkpoint expired at ${checkpoint.ttl}`);
        return null;
      }

      log.info(`loaded checkpoint with ${checkpoint.turns.length} turn(s), expires at ${checkpoint.ttl}`);
      return checkpoint;
    } catch (err) {
      // File doesn't exist or is unreadable - that's fine
      log.debug("no valid checkpoint found");
      return null;
    }
  }

  /**
   * Clear (delete) the checkpoint file.
   * Called after successful injection of checkpoint context.
   */
  async clearCheckpoint(): Promise<void> {
    try {
      await unlink(this.checkpointPath);
      log.info("cleared checkpoint");
    } catch (err) {
      // File doesn't exist - that's fine
      log.debug("no checkpoint to clear");
    }
  }

  /**
   * Format entries for recall injection.
   * Returns a formatted string suitable for injecting into agent context.
   *
   * Format:
   * ## Recent Conversation (last X hours)
   * [10:32] User: message content
   * [10:33] Assistant: response content
   *
   * Content is trimmed to approximately maxTokens.
   */
  formatForRecall(entries: TranscriptEntry[], maxTokens: number): string {
    if (entries.length === 0) {
      return "";
    }

    const maxChars = maxTokens * TranscriptManager.CHARS_PER_TOKEN;
    const lines: string[] = [];

    // Calculate time range for header
    const firstEntry = new Date(entries[0].timestamp);
    const lastEntry = new Date(entries[entries.length - 1].timestamp);
    const hoursDiff = Math.round((lastEntry.getTime() - firstEntry.getTime()) / (60 * 60 * 1000));

    // Add header
    if (hoursDiff < 1) {
      lines.push("## Recent Conversation (last few minutes)");
    } else {
      lines.push(`## Recent Conversation (last ${hoursDiff} hour${hoursDiff === 1 ? "" : "s"})`);
    }
    lines.push("");

    // Format each entry
    const formattedEntries: string[] = [];
    for (const entry of entries) {
      const time = new Date(entry.timestamp);
      const timeStr = time.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const roleLabel = entry.role === "user" ? "User" : "Assistant";
      formattedEntries.push(`[${timeStr}] ${roleLabel}: ${entry.content}`);
    }

    // Build output, trimming from the beginning if too long
    // (we want to keep the most recent context)
    let totalChars = lines.join("\n").length;
    const selectedEntries: string[] = [];

    for (let i = formattedEntries.length - 1; i >= 0; i--) {
      const entry = formattedEntries[i];
      const entryChars = entry.length + 1; // +1 for newline

      if (totalChars + entryChars > maxChars && selectedEntries.length > 0) {
        // Adding this entry would exceed limit, and we have some entries already
        break;
      }

      selectedEntries.unshift(entry);
      totalChars += entryChars;
    }

    lines.push(...selectedEntries);
    lines.push(""); // Trailing newline

    const result = lines.join("\n");
    log.debug(`formatted ${selectedEntries.length}/${entries.length} transcript entries for recall (~${result.length} chars)`);

    return result;
  }

  /**
   * Create a checkpoint from the current buffer state.
   * Helper method for creating checkpoints before compaction.
   */
  createCheckpoint(sessionKey: string, turns: TranscriptEntry[], ttlHours?: number): Checkpoint {
    const ttl = ttlHours ?? TranscriptManager.DEFAULT_CHECKPOINT_TTL_HOURS;
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + ttl);

    return {
      sessionKey,
      capturedAt: new Date().toISOString(),
      turns: [...turns], // Copy turns to avoid mutation
      ttl: expiresAt.toISOString(),
    };
  }

  /**
   * Get statistics about stored transcripts.
   * Returns counts from the hierarchical directory structure.
   */
  async getStats(): Promise<{
    totalFiles: number;
    totalEntries: number;
    oldestFile: string | null;
    newestFile: string | null;
    channelTypes: Record<string, number>;
  }> {
    try {
      const allFiles = await this.getAllTranscriptFiles();

      if (allFiles.length === 0) {
        return {
          totalFiles: 0,
          totalEntries: 0,
          oldestFile: null,
          newestFile: null,
          channelTypes: {},
        };
      }

      // Sort files by path
      const sortedFiles = allFiles.sort();

      let totalEntries = 0;
      const channelTypes: Record<string, number> = {};

      for (const relativePath of allFiles) {
        const filePath = path.join(this.transcriptsDir, relativePath);
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.trim().split("\n").filter(Boolean);
          totalEntries += lines.length;

          // Count by channel type (first directory in path)
          const channelType = relativePath.includes(path.sep)
            ? relativePath.split(path.sep)[0]
            : "legacy";
          channelTypes[channelType] = (channelTypes[channelType] || 0) + 1;
        } catch {
          // Skip unreadable files
        }
      }

      return {
        totalFiles: allFiles.length,
        totalEntries,
        oldestFile: sortedFiles[0],
        newestFile: sortedFiles[sortedFiles.length - 1],
        channelTypes,
      };
    } catch (err) {
      log.error("failed to get transcript stats:", err);
      return {
        totalFiles: 0,
        totalEntries: 0,
        oldestFile: null,
        newestFile: null,
        channelTypes: {},
      };
    }
  }
}
