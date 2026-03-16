import type Database from "better-sqlite3";
import { log } from "../logger.js";

export interface LcmMessage {
  id: number;
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
  token_count: number;
  created_at: string;
  metadata: string | null;
}

export interface LcmSearchResult {
  turn_index: number;
  role: string;
  snippet: string;
  session_id: string;
  score: number;
}

export interface LcmSearchWithContentResult {
  id: number;
  turn_index: number;
  role: string;
  content: string;
  session_id: string;
  score: number;
}

/** Rough token count: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class LcmArchive {
  constructor(private readonly db: Database.Database) {}

  /** Append a message to the archive. Returns the row id. */
  appendMessage(
    sessionId: string,
    turnIndex: number,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): number {
    const tokenCount = estimateTokens(content);
    const now = new Date().toISOString();
    const metaJson = metadata ? JSON.stringify(metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO lcm_messages (session_id, turn_index, role, content, token_count, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(sessionId, turnIndex, role, content, tokenCount, now, metaJson);
    const rowId = Number(result.lastInsertRowid);

    // Keep FTS in sync
    this.db
      .prepare("INSERT INTO lcm_messages_fts (rowid, content) VALUES (?, ?)")
      .run(rowId, content);

    return rowId;
  }

  /** Append multiple messages in a single transaction. */
  appendMessages(
    sessionId: string,
    messages: Array<{ turnIndex: number; role: string; content: string; metadata?: Record<string, unknown> }>,
  ): void {
    if (messages.length === 0) return;

    const txn = this.db.transaction(() => {
      for (const msg of messages) {
        this.appendMessage(sessionId, msg.turnIndex, msg.role, msg.content, msg.metadata);
      }
    });
    txn();
  }

  /** Get the highest turn_index for a session, or -1 if none. */
  getMaxTurnIndex(sessionId: string): number {
    const row = this.db
      .prepare("SELECT MAX(turn_index) as max_turn FROM lcm_messages WHERE session_id = ?")
      .get(sessionId) as { max_turn: number | null } | undefined;
    return row?.max_turn ?? -1;
  }

  /** Retrieve messages in a turn range (inclusive). */
  getMessages(sessionId: string, fromTurn: number, toTurn: number): LcmMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM lcm_messages WHERE session_id = ? AND turn_index >= ? AND turn_index <= ? ORDER BY turn_index",
      )
      .all(sessionId, fromTurn, toTurn) as LcmMessage[];
  }

  /** Retrieve unsummarized messages (after last leaf summary). */
  getUnsummarizedMessages(sessionId: string): LcmMessage[] {
    const lastLeafEnd = this.db
      .prepare(
        "SELECT MAX(msg_end) as last_end FROM lcm_summary_nodes WHERE session_id = ? AND depth = 0",
      )
      .get(sessionId) as { last_end: number | null } | undefined;

    const lastSummarized = lastLeafEnd?.last_end ?? -1;
    return this.db
      .prepare(
        "SELECT * FROM lcm_messages WHERE session_id = ? AND turn_index > ? ORDER BY turn_index",
      )
      .all(sessionId, lastSummarized) as LcmMessage[];
  }

  /** Full-text search across all messages. */
  search(query: string, limit: number, sessionId?: string): LcmSearchResult[] {
    try {
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return [];

      let sql: string;
      const params: unknown[] = [ftsQuery];

      if (sessionId) {
        sql = `
          SELECT m.turn_index, m.role, snippet(lcm_messages_fts, 0, '>>>', '<<<', '...', 48) as snippet,
                 m.session_id, rank
          FROM lcm_messages_fts f
          JOIN lcm_messages m ON m.id = f.rowid
          WHERE lcm_messages_fts MATCH ?
            AND m.session_id = ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(sessionId, limit);
      } else {
        sql = `
          SELECT m.turn_index, m.role, snippet(lcm_messages_fts, 0, '>>>', '<<<', '...', 48) as snippet,
                 m.session_id, rank
          FROM lcm_messages_fts f
          JOIN lcm_messages m ON m.id = f.rowid
          WHERE lcm_messages_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(limit);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        turn_index: number;
        role: string;
        snippet: string;
        session_id: string;
        rank: number;
      }>;

      return rows.map((r) => ({
        turn_index: r.turn_index,
        role: r.role,
        snippet: r.snippet,
        session_id: r.session_id,
        score: -r.rank, // FTS5 rank is negative; negate for ascending score
      }));
    } catch (err) {
      log.debug(`LCM FTS search error: ${err}`);
      return [];
    }
  }

  /**
   * Full-text search returning focused excerpts around matching terms.
   * Returns ~1000-char windows centered on query term matches.
   * Deduplicates by message id and returns results sorted by FTS rank.
   */
  searchWithContent(query: string, limit: number, sessionId?: string, excerptChars = 1000): LcmSearchWithContentResult[] {
    try {
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return [];

      // Extract content words from query for excerpt windowing
      const queryWords = query
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
        .map((w) => w.toLowerCase());

      let sql: string;
      const params: unknown[] = [ftsQuery];

      if (sessionId) {
        sql = `
          SELECT m.id, m.turn_index, m.role, m.content, m.session_id, rank
          FROM lcm_messages_fts f
          JOIN lcm_messages m ON m.id = f.rowid
          WHERE lcm_messages_fts MATCH ?
            AND m.session_id = ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(sessionId, limit);
      } else {
        sql = `
          SELECT m.id, m.turn_index, m.role, m.content, m.session_id, rank
          FROM lcm_messages_fts f
          JOIN lcm_messages m ON m.id = f.rowid
          WHERE lcm_messages_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(limit);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: number;
        turn_index: number;
        role: string;
        content: string;
        session_id: string;
        rank: number;
      }>;

      // Deduplicate by message id (same message may match multiple terms)
      const seen = new Set<number>();
      const results: LcmSearchWithContentResult[] = [];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        results.push({
          id: r.id,
          turn_index: r.turn_index,
          role: r.role,
          content: extractExcerpt(r.content, queryWords, excerptChars),
          session_id: r.session_id,
          score: -r.rank,
        });
      }
      return results;
    } catch (err) {
      log.debug(`LCM FTS searchWithContent error: ${err}`);
      return [];
    }
  }

  /** Get total message count for a session. */
  getMessageCount(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM lcm_messages WHERE session_id = ?")
      .get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /** Get total message count across all sessions. */
  getTotalMessageCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM lcm_messages")
      .get() as { cnt: number };
    return row.cnt;
  }

  /** Prune messages older than retentionDays. */
  pruneOldMessages(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();

    // Delete from FTS first
    this.db
      .prepare(
        "DELETE FROM lcm_messages_fts WHERE rowid IN (SELECT id FROM lcm_messages WHERE created_at < ?)",
      )
      .run(cutoff);

    const result = this.db
      .prepare("DELETE FROM lcm_messages WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }
}

/**
 * Extract a focused excerpt from content centered on query term matches.
 * Returns a window of ~excerptChars around the first matching term.
 * If content is shorter than excerptChars, returns the full content.
 */
function extractExcerpt(content: string, queryWords: string[], excerptChars: number): string {
  if (content.length <= excerptChars) return content;

  // Find the earliest position of any query word in the content
  const contentLower = content.toLowerCase();
  let bestPos = -1;
  for (const word of queryWords) {
    const pos = contentLower.indexOf(word);
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
      bestPos = pos;
    }
  }

  // If no match found (shouldn't happen for FTS results), return start
  if (bestPos === -1) {
    return content.slice(0, excerptChars) + "...";
  }

  // Center the window around the match
  const halfWindow = Math.floor(excerptChars / 2);
  let start = Math.max(0, bestPos - halfWindow);
  let end = Math.min(content.length, start + excerptChars);

  // Adjust start if we hit the end
  if (end === content.length) {
    start = Math.max(0, end - excerptChars);
  }

  // Extend to sentence boundaries if possible
  if (start > 0) {
    const sentenceStart = content.lastIndexOf(". ", start);
    if (sentenceStart !== -1 && start - sentenceStart < 200) {
      start = sentenceStart + 2;
    }
  }
  if (end < content.length) {
    const sentenceEnd = content.indexOf(". ", end - 1);
    if (sentenceEnd !== -1 && sentenceEnd - end < 200) {
      end = sentenceEnd + 1;
    }
  }

  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return prefix + content.slice(start, end) + suffix;
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "between",
  "through", "during", "before", "after", "and", "but", "or", "nor",
  "not", "so", "if", "then", "than", "that", "this", "it", "its",
  "what", "which", "who", "whom", "how", "when", "where", "why",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "only", "own", "same", "just", "very",
  "my", "your", "his", "her", "our", "their", "me", "him", "us", "them",
  "i", "you", "he", "she", "we", "they",
]);

/**
 * Sanitize a query for FTS5 MATCH.
 * Uses OR logic so partial matches rank higher than no matches.
 * Filters stopwords to focus on content words.
 */
function sanitizeFtsQuery(raw: string): string {
  const words = raw
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
  if (words.length === 0) {
    // If all words were stopwords, fall back to using all words
    const allWords = raw.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
    if (allWords.length === 0) return "";
    return allWords.map((w) => `"${w}"`).join(" OR ");
  }
  return words.map((w) => `"${w}"`).join(" OR ");
}
