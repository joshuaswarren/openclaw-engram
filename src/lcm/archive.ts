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

/** Sanitize a query for FTS5 MATCH — wrap each word in quotes to avoid syntax errors. */
function sanitizeFtsQuery(raw: string): string {
  const words = raw
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(" ");
}
