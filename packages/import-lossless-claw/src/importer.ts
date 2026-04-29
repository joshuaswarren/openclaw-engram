// ---------------------------------------------------------------------------
// lossless-claw → Remnic LCM importer (orchestration)
//
// Streams rows from a lossless-claw SQLite export into a Remnic LCM
// SQLite database opened by the caller. The Remnic database must already
// have its schema applied (use openLcmDatabase() from @remnic/core).
//
// Idempotency: messages are keyed on (session_id, turn_index) — the same
// natural key Remnic's own indexer uses. Summary nodes are keyed on the
// preserved primary id.
//
// FTS sync: lcm_messages_fts and lcm_summaries_fts are external-content
// FTS5 tables, so every insert must be mirrored. We do this in the same
// transaction as the row write to keep the index consistent on crash.
//
// Compaction-event boundary: per-session, we insert one row into
// lcm_compaction_events with tokens_before == tokens_after, marking the
// post-import state from which Remnic's own compaction will operate.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

import {
  assertLosslessClawSchema,
  listConversations,
  listMessagesForConversation,
  listSummaries,
  listSummaryMessages,
  listSummaryParents,
} from "./source.js";
import {
  indexSummaryDerivations,
  isMultiParent,
  mapMessage,
  mapSummary,
  resolveSessionId,
  resolveSummarySession,
} from "./transform.js";

export interface ImportLosslessClawOptions {
  /** Open lossless-claw source database (read-only OK). */
  sourceDb: Database.Database;
  /** Open Remnic LCM destination database with schema applied. */
  destDb: Database.Database;
  /** When true, run all reads + transformations but skip writes. */
  dryRun?: boolean;
  /** Optional set of session_ids (post-resolve) to import. Empty = all. */
  sessionFilter?: ReadonlySet<string>;
  /** Hook for status output (defaults to no-op). */
  onLog?: (line: string) => void;
}

export interface ImportLosslessClawResult {
  conversationsScanned: number;
  sessionsTouched: string[];
  messagesInserted: number;
  messagesSkipped: number;
  summariesInserted: number;
  summariesSkipped: number;
  summariesMultiParentCollapsed: number;
  summariesSkippedNoMessages: number;
  summariesSkippedMultiSession: number;
  compactionEventsInserted: number;
  dryRun: boolean;
}

const NOOP_LOG = (_line: string): void => {
  /* default sink */
};

export function importLosslessClaw(
  options: ImportLosslessClawOptions,
): ImportLosslessClawResult {
  const { sourceDb, destDb } = options;
  const dryRun = options.dryRun ?? false;
  const sessionFilter = options.sessionFilter;
  const log = options.onLog ?? NOOP_LOG;

  assertLosslessClawSchema(sourceDb);

  const result: ImportLosslessClawResult = {
    conversationsScanned: 0,
    sessionsTouched: [],
    messagesInserted: 0,
    messagesSkipped: 0,
    summariesInserted: 0,
    summariesSkipped: 0,
    summariesMultiParentCollapsed: 0,
    summariesSkippedNoMessages: 0,
    summariesSkippedMultiSession: 0,
    compactionEventsInserted: 0,
    dryRun,
  };

  // ── Pre-resolve session ids per conversation + per message id ──────────
  const conversations = listConversations(sourceDb);
  result.conversationsScanned = conversations.length;

  const sessionByConvId = new Map<string, string>();
  const sessionByMessageId = new Map<string, string>();

  for (const c of conversations) {
    sessionByConvId.set(c.conversation_id, resolveSessionId(c));
  }

  // Materialize messages once per conversation; reused for the write pass
  // and (via sessionByMessageId) for summary mapping.
  const messagesByConv = new Map<
    string,
    ReturnType<typeof listMessagesForConversation>
  >();

  for (const c of conversations) {
    const msgs = listMessagesForConversation(sourceDb, c.conversation_id);
    messagesByConv.set(c.conversation_id, msgs);
    const session = sessionByConvId.get(c.conversation_id)!;
    for (const m of msgs) {
      sessionByMessageId.set(m.message_id, session);
    }
  }

  // Group conversations by session in deterministic order so two
  // conversations resolving to the same session id get a consistent
  // assignment of session-global turn_index values across runs.
  const orderedConversations = [...conversations].sort((a, b) =>
    a.conversation_id.localeCompare(b.conversation_id),
  );
  const convsBySession = new Map<string, typeof orderedConversations>();
  for (const c of orderedConversations) {
    const session = sessionByConvId.get(c.conversation_id)!;
    const list = convsBySession.get(session) ?? [];
    list.push(c);
    convsBySession.set(session, list);
  }

  // ── Insert messages ────────────────────────────────────────────────────
  // Dedup uses source identity (`metadata.conversation_id` +
  // `metadata.source_seq`) rather than `(session_id, turn_index)` so two
  // source conversations sharing one session can both contribute messages
  // without one's `seq=N` masking the other's `seq=N` (Codex P1 review).
  const sourceMessageLookupStmt = destDb.prepare(
    "SELECT turn_index FROM lcm_messages " +
      "WHERE session_id = ? " +
      "  AND json_extract(metadata, '$.conversation_id') = ? " +
      "  AND json_extract(metadata, '$.source_seq') = ? " +
      "LIMIT 1",
  );
  const insertMessageStmt = destDb.prepare(
    "INSERT INTO lcm_messages (session_id, turn_index, role, content, token_count, created_at, metadata) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMessageFtsStmt = destDb.prepare(
    "INSERT INTO lcm_messages_fts (rowid, content) VALUES (?, ?)",
  );
  const maxTurnInDestStmt = destDb.prepare(
    "SELECT IFNULL(MAX(turn_index), -1) AS max FROM lcm_messages WHERE session_id = ?",
  );

  const sessionsTouched = new Set<string>();
  // Mapping from source message_id → assigned (or pre-existing)
  // turn_index. Populated for both inserted rows and dedup-skipped rows
  // so summary mapping (msg_start/msg_end) reflects real turn indices.
  const turnIndexByMessageId = new Map<string, number>();

  function assignTurnIndices(forWrite: boolean): void {
    for (const [session, convs] of convsBySession) {
      if (sessionFilter && !sessionFilter.has(session)) continue;
      const startRow = maxTurnInDestStmt.get(session) as { max: number };
      let nextTurn = startRow.max + 1;
      for (const c of convs) {
        const msgs = messagesByConv.get(c.conversation_id) ?? [];
        for (const m of msgs) {
          const existing = sourceMessageLookupStmt.get(
            session,
            c.conversation_id,
            m.seq,
          ) as { turn_index: number } | undefined;
          if (existing) {
            turnIndexByMessageId.set(m.message_id, existing.turn_index);
            result.messagesSkipped += 1;
            continue;
          }
          const ti = nextTurn++;
          turnIndexByMessageId.set(m.message_id, ti);
          if (forWrite) {
            const mapped = mapMessage(c, m, ti);
            const info = insertMessageStmt.run(
              mapped.session_id,
              mapped.turn_index,
              mapped.role,
              mapped.content,
              mapped.token_count,
              mapped.created_at,
              mapped.metadata,
            );
            insertMessageFtsStmt.run(
              Number(info.lastInsertRowid),
              mapped.content,
            );
          }
          result.messagesInserted += 1;
          sessionsTouched.add(session);
        }
      }
    }
  }

  if (!dryRun) {
    const writeMessages = destDb.transaction(() => assignTurnIndices(true));
    writeMessages();
  } else {
    // Dry run: walk the same iteration to populate counters and
    // turnIndexByMessageId without mutating either DB.
    assignTurnIndices(false);
  }

  // ── Insert summaries ───────────────────────────────────────────────────
  const summaries = listSummaries(sourceDb);
  const summaryMessages = listSummaryMessages(sourceDb);
  const summaryParents = listSummaryParents(sourceDb);
  const derivations = indexSummaryDerivations(summaryMessages, summaryParents);

  const summaryExistsStmt = destDb.prepare(
    "SELECT 1 AS hit FROM lcm_summary_nodes WHERE id = ? LIMIT 1",
  );
  const insertSummaryStmt = destDb.prepare(
    "INSERT INTO lcm_summary_nodes (id, session_id, depth, parent_id, summary_text, token_count, msg_start, msg_end, escalation, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSummaryFtsStmt = destDb.prepare(
    "INSERT INTO lcm_summaries_fts (rowid, summary_text) VALUES (?, ?)",
  );
  const lookupSummaryRowidStmt = destDb.prepare(
    "SELECT rowid AS rowid FROM lcm_summary_nodes WHERE id = ?",
  );

  const writeSummaries = destDb.transaction(() => {
    for (const summary of summaries) {
      const derivation = derivations.get(summary.summary_id);
      if (!derivation || derivation.messageIds.length === 0) {
        result.summariesSkippedNoMessages += 1;
        log(
          `skip summary ${summary.summary_id}: no message references in summary_messages`,
        );
        continue;
      }
      const session = resolveSummarySession(
        derivation.messageIds,
        sessionByMessageId,
      );
      if (!session) {
        result.summariesSkippedMultiSession += 1;
        log(
          `skip summary ${summary.summary_id}: covers messages from multiple sessions`,
        );
        continue;
      }
      if (sessionFilter && !sessionFilter.has(session)) continue;

      const messageSeqs: number[] = [];
      for (const mid of derivation.messageIds) {
        const seq = turnIndexByMessageId.get(mid);
        if (typeof seq === "number") messageSeqs.push(seq);
      }
      if (messageSeqs.length === 0) {
        result.summariesSkippedNoMessages += 1;
        log(
          `skip summary ${summary.summary_id}: message ids exist but seqs unresolved`,
        );
        continue;
      }

      const mapped = mapSummary({
        summary,
        parents: derivation.parents,
        messageSeqs,
        sessionId: session,
      });

      if (isMultiParent(derivation.parents)) {
        result.summariesMultiParentCollapsed += 1;
        log(
          `summary ${summary.summary_id} has ${derivation.parents.length} parents; ` +
            `keeping ${mapped.parent_id ?? "(none)"} (Remnic LCM is single-parent).`,
        );
      }

      const existing = summaryExistsStmt.get(mapped.id) as
        | { hit: number }
        | undefined;
      if (existing) {
        result.summariesSkipped += 1;
        continue;
      }
      insertSummaryStmt.run(
        mapped.id,
        mapped.session_id,
        mapped.depth,
        mapped.parent_id,
        mapped.summary_text,
        mapped.token_count,
        mapped.msg_start,
        mapped.msg_end,
        mapped.escalation,
        mapped.created_at,
      );
      const row = lookupSummaryRowidStmt.get(mapped.id) as
        | { rowid: number }
        | undefined;
      if (row) {
        insertSummaryFtsStmt.run(row.rowid, mapped.summary_text);
      }
      result.summariesInserted += 1;
      sessionsTouched.add(mapped.session_id);
    }
  });

  if (!dryRun) {
    writeSummaries();
  } else {
    // Dry run: count without writing.
    for (const summary of summaries) {
      const derivation = derivations.get(summary.summary_id);
      if (!derivation || derivation.messageIds.length === 0) {
        result.summariesSkippedNoMessages += 1;
        continue;
      }
      const session = resolveSummarySession(
        derivation.messageIds,
        sessionByMessageId,
      );
      if (!session) {
        result.summariesSkippedMultiSession += 1;
        continue;
      }
      if (sessionFilter && !sessionFilter.has(session)) continue;
      const messageSeqs: number[] = [];
      for (const mid of derivation.messageIds) {
        const seq = turnIndexByMessageId.get(mid);
        if (typeof seq === "number") messageSeqs.push(seq);
      }
      if (messageSeqs.length === 0) {
        result.summariesSkippedNoMessages += 1;
        continue;
      }
      const existing = summaryExistsStmt.get(summary.summary_id) as
        | { hit: number }
        | undefined;
      if (existing) {
        result.summariesSkipped += 1;
      } else {
        result.summariesInserted += 1;
        sessionsTouched.add(session);
      }
      if (isMultiParent(derivation.parents)) {
        result.summariesMultiParentCollapsed += 1;
      }
    }
  }

  // ── Compaction-event boundary ──────────────────────────────────────────
  // Insert one marker row per session that gained data. tokens_before
  // equals tokens_after to encode "this is an import boundary, not a real
  // compaction event"; any consumer that needs the distinction can detect
  // the equality.
  //
  // Token totals are queried from the destination at boundary-write time
  // rather than accumulated from this run's newly-inserted rows. That
  // way a session whose only new rows are summaries (e.g. partial retry
  // after a crash between message and summary transactions) still gets
  // a correct anchor reflecting the messages already in the destination
  // (Cursor Bugbot review on PR #797).
  if (!dryRun) {
    const insertEventStmt = destDb.prepare(
      "INSERT INTO lcm_compaction_events (session_id, fired_at, msg_before, tokens_before, tokens_after) " +
        "VALUES (?, ?, ?, ?, ?)",
    );
    const maxTurnStmt = destDb.prepare(
      "SELECT IFNULL(MAX(turn_index), -1) AS max_turn FROM lcm_messages WHERE session_id = ?",
    );
    const totalTokensStmt = destDb.prepare(
      "SELECT IFNULL(SUM(token_count), 0) AS total FROM lcm_messages WHERE session_id = ?",
    );
    const writeEvents = destDb.transaction(() => {
      const firedAt = new Date().toISOString();
      for (const session of sessionsTouched) {
        const turnRow = maxTurnStmt.get(session) as { max_turn: number };
        const msgBefore = turnRow.max_turn + 1;
        const tokRow = totalTokensStmt.get(session) as { total: number };
        const tokens = tokRow.total;
        insertEventStmt.run(session, firedAt, msgBefore, tokens, tokens);
        result.compactionEventsInserted += 1;
      }
    });
    writeEvents();
  }

  result.sessionsTouched = [...sessionsTouched].sort();
  return result;
}
