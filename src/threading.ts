/**
 * Conversation Threading (Phase 3B)
 *
 * Groups related memories into conversation threads with auto-generated titles.
 * Thread boundary detection: new session key OR time gap > threshold.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import type { BufferTurn, ConversationThread } from "./types.js";

/** Stop words for title extraction */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
  "she", "it", "they", "them", "their", "what", "which", "who", "how",
  "when", "where", "why", "and", "but", "or", "if", "because", "so",
  "just", "about", "like", "also", "very", "really", "here", "there",
]);

/**
 * Extract top keywords from content for thread title.
 * Simple TF approach (no IDF needed for single thread).
 */
function extractKeywords(content: string, maxKeywords: number = 3): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

  // Count frequencies
  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  // Sort by frequency, take top N
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

/**
 * Generate a thread title from keywords.
 */
function generateTitle(keywords: string[]): string {
  if (keywords.length === 0) return "Untitled Thread";
  // Capitalize and join
  return keywords
    .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
    .join(", ");
}

export class ThreadingManager {
  private currentThreadId: string | null = null;
  private lastTurnTimestamp: number | null = null;
  private lastSessionKey: string | null = null;

  constructor(
    private readonly threadsDir: string,
    private readonly gapMinutes: number = 30,
  ) {}

  async ensureDirectory(): Promise<void> {
    await mkdir(this.threadsDir, { recursive: true });
  }

  /**
   * Check if we should start a new thread based on session key and time gap.
   */
  shouldStartNewThread(turn: BufferTurn): boolean {
    const turnTime = new Date(turn.timestamp).getTime();

    // Different session key = new thread
    if (turn.sessionKey && this.lastSessionKey && turn.sessionKey !== this.lastSessionKey) {
      return true;
    }

    // Time gap > threshold = new thread
    if (this.lastTurnTimestamp) {
      const gapMs = turnTime - this.lastTurnTimestamp;
      const gapMinutes = gapMs / (1000 * 60);
      if (gapMinutes > this.gapMinutes) {
        return true;
      }
    }

    // No current thread = new thread
    if (!this.currentThreadId) {
      return true;
    }

    return false;
  }

  /**
   * Process a turn and return the thread ID it belongs to.
   * Creates a new thread if needed.
   */
  async processTurn(turn: BufferTurn, episodeIds: string[]): Promise<string> {
    await this.ensureDirectory();

    const turnTime = new Date(turn.timestamp).getTime();

    if (this.shouldStartNewThread(turn)) {
      // Create new thread
      const threadId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const thread: ConversationThread = {
        id: threadId,
        title: "New Thread", // Will be updated later with keywords
        createdAt: turn.timestamp,
        updatedAt: turn.timestamp,
        sessionKey: turn.sessionKey,
        episodeIds: [...episodeIds],
        linkedThreadIds: [],
      };

      await this.saveThread(thread);
      this.currentThreadId = threadId;
      log.debug(`created new thread ${threadId}`);
    } else if (this.currentThreadId) {
      // Add episodes to current thread
      const thread = await this.loadThread(this.currentThreadId);
      if (thread) {
        for (const id of episodeIds) {
          if (!thread.episodeIds.includes(id)) {
            thread.episodeIds.push(id);
          }
        }
        thread.updatedAt = turn.timestamp;
        await this.saveThread(thread);
      }
    }

    this.lastTurnTimestamp = turnTime;
    this.lastSessionKey = turn.sessionKey ?? null;

    return this.currentThreadId!;
  }

  /**
   * Update thread title based on accumulated content.
   */
  async updateThreadTitle(threadId: string, content: string): Promise<void> {
    const thread = await this.loadThread(threadId);
    if (!thread) return;

    const keywords = extractKeywords(content);
    const title = generateTitle(keywords);

    if (title !== thread.title) {
      thread.title = title;
      thread.updatedAt = new Date().toISOString();
      await this.saveThread(thread);
      log.debug(`updated thread ${threadId} title: ${title}`);
    }
  }

  /**
   * Get all threads, sorted by updatedAt desc.
   */
  async getAllThreads(): Promise<ConversationThread[]> {
    try {
      const files = await readdir(this.threadsDir);
      const threads: ConversationThread[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const thread = await this.loadThread(file.replace(".json", ""));
        if (thread) threads.push(thread);
      }

      return threads.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    } catch {
      return [];
    }
  }

  /**
   * Get a thread by ID.
   */
  async loadThread(threadId: string): Promise<ConversationThread | null> {
    const filePath = path.join(this.threadsDir, `${threadId}.json`);
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as ConversationThread;
    } catch {
      return null;
    }
  }

  /**
   * Save a thread.
   */
  async saveThread(thread: ConversationThread): Promise<void> {
    await this.ensureDirectory();
    const filePath = path.join(this.threadsDir, `${thread.id}.json`);
    await writeFile(filePath, JSON.stringify(thread, null, 2), "utf-8");
  }

  /**
   * Link two threads together.
   */
  async linkThreads(threadId1: string, threadId2: string): Promise<boolean> {
    const thread1 = await this.loadThread(threadId1);
    const thread2 = await this.loadThread(threadId2);

    if (!thread1 || !thread2) return false;

    // Add bidirectional links
    if (!thread1.linkedThreadIds.includes(threadId2)) {
      thread1.linkedThreadIds.push(threadId2);
      await this.saveThread(thread1);
    }

    if (!thread2.linkedThreadIds.includes(threadId1)) {
      thread2.linkedThreadIds.push(threadId1);
      await this.saveThread(thread2);
    }

    return true;
  }

  /**
   * Get the current thread ID (if any).
   */
  getCurrentThreadId(): string | null {
    return this.currentThreadId;
  }

  /**
   * Reset threading state (e.g., on plugin restart).
   */
  reset(): void {
    this.currentThreadId = null;
    this.lastTurnTimestamp = null;
    this.lastSessionKey = null;
  }
}
