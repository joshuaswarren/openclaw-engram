// ---------------------------------------------------------------------------
// Importer integration tests.
//
// Uses synthetic in-memory SQLite databases — no real user data, no fixture
// files. Per CLAUDE.md (public repo policy): test data must be synthetic.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { importLosslessClaw } from "./importer.js";

type DbHandle = ReturnType<typeof BetterSqlite3>;

interface SeedMessage {
  message_id: string;
  conversation_id: string;
  seq: number;
  role: string;
  content: string;
  token_count: number;
  identity_hash?: string | null;
  created_at: string;
}

interface SeedSummary {
  summary_id: string;
  kind: "leaf" | "condensed";
  depth: number;
  content: string;
  token_count: number;
  earliest_at?: string | null;
  latest_at?: string | null;
  message_ids: string[];
  parent_ids?: Array<{ parent_summary_id: string; ordinal: number }>;
}

interface SeedConversation {
  conversation_id: string;
  session_id?: string | null;
  session_key?: string | null;
  title?: string | null;
}

function buildSourceDb(seed: {
  conversations: SeedConversation[];
  messages: SeedMessage[];
  summaries?: SeedSummary[];
}): DbHandle {
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY,
      session_id      TEXT,
      session_key     TEXT,
      title           TEXT
    );
    CREATE TABLE messages (
      message_id      TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      token_count     INTEGER NOT NULL,
      identity_hash   TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE summaries (
      summary_id      TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      depth           INTEGER NOT NULL,
      content         TEXT NOT NULL,
      token_count     INTEGER NOT NULL,
      earliest_at     TEXT,
      latest_at       TEXT
    );
    CREATE TABLE summary_messages (
      summary_id TEXT NOT NULL,
      message_id TEXT NOT NULL
    );
    CREATE TABLE summary_parents (
      summary_id        TEXT NOT NULL,
      parent_summary_id TEXT NOT NULL,
      ordinal           INTEGER NOT NULL
    );
  `);

  const insConv = db.prepare(
    "INSERT INTO conversations (conversation_id, session_id, session_key, title) VALUES (?, ?, ?, ?)",
  );
  for (const c of seed.conversations) {
    insConv.run(
      c.conversation_id,
      c.session_id ?? null,
      c.session_key ?? null,
      c.title ?? null,
    );
  }

  const insMsg = db.prepare(
    "INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, identity_hash, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const m of seed.messages) {
    insMsg.run(
      m.message_id,
      m.conversation_id,
      m.seq,
      m.role,
      m.content,
      m.token_count,
      m.identity_hash ?? null,
      m.created_at,
    );
  }

  if (seed.summaries) {
    const insSum = db.prepare(
      "INSERT INTO summaries (summary_id, kind, depth, content, token_count, earliest_at, latest_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insSumMsg = db.prepare(
      "INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)",
    );
    const insSumPar = db.prepare(
      "INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)",
    );
    for (const s of seed.summaries) {
      insSum.run(
        s.summary_id,
        s.kind,
        s.depth,
        s.content,
        s.token_count,
        s.earliest_at ?? null,
        s.latest_at ?? null,
      );
      for (const mid of s.message_ids) {
        insSumMsg.run(s.summary_id, mid);
      }
      for (const p of s.parent_ids ?? []) {
        insSumPar.run(s.summary_id, p.parent_summary_id, p.ordinal);
      }
    }
  }

  return db;
}

/**
 * Build a destination database with the EXACT Remnic LCM schema (kept
 * inline here so the test fails loudly if the production schema drifts).
 * Mirrors packages/remnic-core/src/lcm/schema.ts.
 */
function buildDestDb(): DbHandle {
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE lcm_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE lcm_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      metadata    TEXT
    );
    CREATE INDEX idx_lcm_messages_session ON lcm_messages(session_id, turn_index);

    CREATE TABLE lcm_summary_nodes (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      depth         INTEGER NOT NULL,
      parent_id     TEXT,
      summary_text  TEXT NOT NULL,
      token_count   INTEGER NOT NULL,
      msg_start     INTEGER NOT NULL,
      msg_end       INTEGER NOT NULL,
      escalation    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES lcm_summary_nodes(id)
    );

    CREATE TABLE lcm_compaction_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      fired_at      TEXT NOT NULL,
      msg_before    INTEGER NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after  INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE lcm_messages_fts USING fts5(
      content,
      content=lcm_messages,
      content_rowid=id
    );
    CREATE VIRTUAL TABLE lcm_summaries_fts USING fts5(
      summary_text,
      content=lcm_summary_nodes,
      content_rowid=rowid
    );
  `);
  return db;
}

const TWO_CONVS = (): {
  conversations: SeedConversation[];
  messages: SeedMessage[];
  summaries: SeedSummary[];
} => ({
  conversations: [
    { conversation_id: "conv-A", session_id: "sess-A", title: "topic A" },
    { conversation_id: "conv-B", session_id: null, title: "topic B" },
  ],
  messages: [
    {
      message_id: "m-a-1",
      conversation_id: "conv-A",
      seq: 0,
      role: "user",
      content: "hello A",
      token_count: 2,
      created_at: "2026-04-01T00:00:00.000Z",
    },
    {
      message_id: "m-a-2",
      conversation_id: "conv-A",
      seq: 1,
      role: "assistant",
      content: "hi A back",
      token_count: 3,
      created_at: "2026-04-01T00:00:01.000Z",
    },
    {
      message_id: "m-b-1",
      conversation_id: "conv-B",
      seq: 0,
      role: "user",
      content: "hello B",
      token_count: 2,
      created_at: "2026-04-01T00:01:00.000Z",
    },
  ],
  summaries: [
    {
      summary_id: "sum-A",
      kind: "leaf",
      depth: 0,
      content: "summary of A",
      token_count: 4,
      earliest_at: "2026-04-01T00:00:00.000Z",
      latest_at: "2026-04-01T00:00:01.000Z",
      message_ids: ["m-a-1", "m-a-2"],
    },
  ],
});

describe("importLosslessClaw — basic copy", () => {
  it("copies messages and summary across two conversations, falling back to conversation_id when session_id is null", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(result.conversationsScanned, 2);
    assert.equal(result.messagesInserted, 3);
    assert.equal(result.messagesSkipped, 0);
    assert.equal(result.summariesInserted, 1);
    assert.equal(result.summariesMultiParentCollapsed, 0);
    assert.equal(result.dryRun, false);
    // sessionsTouched: explicit "sess-A" + fallback "conv-B"
    assert.deepEqual(result.sessionsTouched, ["conv-B", "sess-A"]);

    const msgs = dst
      .prepare("SELECT session_id, turn_index, role, content FROM lcm_messages ORDER BY session_id, turn_index")
      .all();
    assert.deepEqual(msgs, [
      { session_id: "conv-B", turn_index: 0, role: "user", content: "hello B" },
      { session_id: "sess-A", turn_index: 0, role: "user", content: "hello A" },
      {
        session_id: "sess-A",
        turn_index: 1,
        role: "assistant",
        content: "hi A back",
      },
    ]);

    const summaries = dst
      .prepare(
        "SELECT id, session_id, depth, msg_start, msg_end, summary_text FROM lcm_summary_nodes",
      )
      .all();
    assert.deepEqual(summaries, [
      {
        id: "sum-A",
        session_id: "sess-A",
        depth: 0,
        msg_start: 0,
        msg_end: 1,
        summary_text: "summary of A",
      },
    ]);
  });
});

describe("importLosslessClaw — idempotency", () => {
  it("re-running imports zero new rows", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();

    const first = importLosslessClaw({ sourceDb: src, destDb: dst });
    const second = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(first.messagesInserted, 3);
    assert.equal(second.messagesInserted, 0);
    assert.equal(second.messagesSkipped, 3);
    assert.equal(second.summariesInserted, 0);
    assert.equal(second.summariesSkipped, 1);

    const total = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_messages")
      .get() as { n: number };
    assert.equal(total.n, 3);
  });
});

describe("importLosslessClaw — FTS sync", () => {
  it("messages_fts and summaries_fts are queryable post-import", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    importLosslessClaw({ sourceDb: src, destDb: dst });

    const ftsMsgs = dst
      .prepare(
        "SELECT lcm_messages.session_id FROM lcm_messages_fts " +
          "JOIN lcm_messages ON lcm_messages.id = lcm_messages_fts.rowid " +
          "WHERE lcm_messages_fts MATCH 'hello'",
      )
      .all() as Array<{ session_id: string }>;
    const sessions = ftsMsgs.map((r) => r.session_id).sort();
    assert.deepEqual(sessions, ["conv-B", "sess-A"]);

    const ftsSums = dst
      .prepare("SELECT count(*) AS n FROM lcm_summaries_fts WHERE lcm_summaries_fts MATCH 'summary'")
      .get() as { n: number };
    assert.equal(ftsSums.n, 1);
  });
});

describe("importLosslessClaw — compaction-event boundary", () => {
  it("inserts one marker per session with tokens_before == tokens_after", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(result.compactionEventsInserted, 2);

    const events = dst
      .prepare(
        "SELECT session_id, msg_before, tokens_before, tokens_after FROM lcm_compaction_events ORDER BY session_id",
      )
      .all() as Array<{
      session_id: string;
      msg_before: number;
      tokens_before: number;
      tokens_after: number;
    }>;
    assert.equal(events.length, 2);
    for (const e of events) {
      assert.equal(
        e.tokens_before,
        e.tokens_after,
        "import marker must encode no-op compaction",
      );
    }
    const byId = new Map(events.map((e) => [e.session_id, e]));
    // sess-A has 2 messages → msg_before = max turn_index + 1 = 2; tokens = 2 + 3 = 5
    assert.equal(byId.get("sess-A")?.msg_before, 2);
    assert.equal(byId.get("sess-A")?.tokens_before, 5);
    // conv-B (fallback) has 1 message → msg_before = 1; tokens = 2
    assert.equal(byId.get("conv-B")?.msg_before, 1);
    assert.equal(byId.get("conv-B")?.tokens_before, 2);
  });

  it("does NOT insert markers in dry-run mode", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.compactionEventsInserted, 0);
    const total = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_compaction_events")
      .get() as { n: number };
    assert.equal(total.n, 0);
  });
});

describe("importLosslessClaw — dry run", () => {
  it("counts what would be inserted without writing", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      dryRun: true,
    });

    assert.equal(result.messagesInserted, 3);
    assert.equal(result.summariesInserted, 1);

    const totalMsgs = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_messages")
      .get() as { n: number };
    assert.equal(totalMsgs.n, 0);
    const totalSums = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_summary_nodes")
      .get() as { n: number };
    assert.equal(totalSums.n, 0);
  });
});

describe("importLosslessClaw — session filter", () => {
  it("limits import to specified resolved sessions", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      sessionFilter: new Set(["sess-A"]),
    });

    assert.equal(result.messagesInserted, 2);
    assert.equal(result.summariesInserted, 1);
    assert.deepEqual(result.sessionsTouched, ["sess-A"]);

    const otherSession = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_messages WHERE session_id = 'conv-B'")
      .get() as { n: number };
    assert.equal(otherSession.n, 0);
  });
});

describe("importLosslessClaw — multi-parent DAG collapse", () => {
  it("counts and logs collapsed multi-parent rows, picks lowest-ordinal parent", () => {
    const seed = TWO_CONVS();
    seed.summaries.push({
      summary_id: "sum-rollup",
      kind: "condensed",
      depth: 1,
      content: "rollup",
      token_count: 8,
      message_ids: ["m-a-1", "m-a-2"],
      parent_ids: [
        { parent_summary_id: "p-late", ordinal: 5 },
        { parent_summary_id: "sum-A", ordinal: 0 },
      ],
    });
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const logs: string[] = [];
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      onLog: (line) => logs.push(line),
    });

    assert.equal(result.summariesMultiParentCollapsed, 1);
    assert.ok(
      logs.some((l) => l.includes("sum-rollup") && l.includes("2 parents")),
      "expected log about multi-parent collapse",
    );

    const row = dst
      .prepare("SELECT parent_id FROM lcm_summary_nodes WHERE id = 'sum-rollup'")
      .get() as { parent_id: string | null };
    assert.equal(row.parent_id, "sum-A");
  });
});

describe("importLosslessClaw — schema rejection", () => {
  it("throws when source DB lacks lossless-claw tables", () => {
    const src = new BetterSqlite3(":memory:");
    src.exec("CREATE TABLE foo (x INTEGER);");
    const dst = buildDestDb();
    assert.throws(
      () => importLosslessClaw({ sourceDb: src, destDb: dst }),
      /lossless-claw tables/,
    );
  });
});

describe("importLosslessClaw — compaction-event token aggregation", () => {
  it("uses the destination's actual SUM(token_count), not just newly-inserted", () => {
    // Simulate a partial-retry scenario: messages already in dest, only
    // summaries new this run. The compaction event must reflect the dest's
    // real token total, not zero.
    const seed = TWO_CONVS();
    const src = buildSourceDb(seed);
    const dst = buildDestDb();

    // Pre-populate dst with the same messages so this run is summary-only.
    importLosslessClaw({ sourceDb: src, destDb: dst });

    // Wipe summaries + compaction events so the next run re-inserts them
    // but messages are already there.
    dst.exec("DELETE FROM lcm_summary_nodes; DELETE FROM lcm_compaction_events;");

    const result = importLosslessClaw({ sourceDb: src, destDb: dst });
    assert.equal(result.messagesInserted, 0);
    assert.equal(result.summariesInserted, 1);
    assert.equal(result.compactionEventsInserted, 1);

    const event = dst
      .prepare(
        "SELECT session_id, tokens_before FROM lcm_compaction_events WHERE session_id = 'sess-A'",
      )
      .get() as { session_id: string; tokens_before: number };
    // Total token_count for sess-A is 2 + 3 = 5, all already present in dest.
    assert.equal(
      event.tokens_before,
      5,
      "summary-only retry must read tokens from dest, not from this run's writes",
    );
  });
});

describe("importLosslessClaw — orphan summaries", () => {
  it("skips summaries with no message references and increments the counter", () => {
    const seed = TWO_CONVS();
    seed.summaries.push({
      summary_id: "sum-orphan",
      kind: "leaf",
      depth: 0,
      content: "orphan",
      token_count: 4,
      message_ids: [],
    });
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });
    assert.equal(result.summariesSkippedNoMessages, 1);
    const row = dst
      .prepare("SELECT count(*) AS n FROM lcm_summary_nodes WHERE id = 'sum-orphan'")
      .get() as { n: number };
    assert.equal(row.n, 0);
  });
});
