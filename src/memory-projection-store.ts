import path from "node:path";
import Database from "better-sqlite3";
import type {
  MemoryLifecycleEvent,
  MemoryProjectionCurrentState,
  MemoryStatus,
} from "./types.js";

export const MEMORY_PROJECTION_SCHEMA_VERSION = 1;

export function getMemoryProjectionPath(memoryDir: string): string {
  return path.join(memoryDir, "state", "memory-projection.sqlite");
}

export function initializeMemoryProjectionDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_current (
      memory_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      lifecycle_state TEXT,
      path_rel TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      superseded_at TEXT,
      entity_ref TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      confidence_tier TEXT NOT NULL,
      memory_kind TEXT,
      access_count INTEGER,
      last_accessed TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_current_status
      ON memory_current(status);

    CREATE TABLE IF NOT EXISTS memory_timeline (
      event_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_order INTEGER NOT NULL,
      actor TEXT NOT NULL,
      reason_code TEXT,
      rule_version TEXT NOT NULL,
      related_memory_ids_json TEXT,
      before_json TEXT,
      after_json TEXT,
      correlation_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_timeline_memory_ts
      ON memory_timeline(memory_id, timestamp, event_order);
  `);
}

function openProjectionReadonly(memoryDir: string): Database.Database | null {
  const dbPath = getMemoryProjectionPath(memoryDir);
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function parseCurrentRow(
  memoryDir: string,
  row: Record<string, unknown> | undefined,
): MemoryProjectionCurrentState | null {
  if (!row) return null;
  if (
    typeof row.memory_id !== "string" ||
    typeof row.category !== "string" ||
    typeof row.status !== "string" ||
    typeof row.path_rel !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.source !== "string" ||
    typeof row.confidence !== "number" ||
    typeof row.confidence_tier !== "string"
  ) {
    return null;
  }

  return {
    memoryId: row.memory_id,
    category: row.category as MemoryProjectionCurrentState["category"],
    status: row.status as MemoryStatus,
    lifecycleState:
      typeof row.lifecycle_state === "string"
        ? (row.lifecycle_state as MemoryProjectionCurrentState["lifecycleState"])
        : undefined,
    path: path.join(memoryDir, row.path_rel),
    pathRel: row.path_rel,
    created: row.created_at,
    updated: row.updated_at,
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : undefined,
    supersededAt: typeof row.superseded_at === "string" ? row.superseded_at : undefined,
    entityRef: typeof row.entity_ref === "string" ? row.entity_ref : undefined,
    source: row.source,
    confidence: row.confidence,
    confidenceTier: row.confidence_tier as MemoryProjectionCurrentState["confidenceTier"],
    memoryKind:
      typeof row.memory_kind === "string"
        ? (row.memory_kind as MemoryProjectionCurrentState["memoryKind"])
        : undefined,
    accessCount: typeof row.access_count === "number" ? row.access_count : undefined,
    lastAccessed: typeof row.last_accessed === "string" ? row.last_accessed : undefined,
  };
}

function parseTimelineRows(rows: Array<Record<string, unknown>>): MemoryLifecycleEvent[] {
  const out: MemoryLifecycleEvent[] = [];
  for (const row of rows) {
    if (
      typeof row.event_id !== "string" ||
      typeof row.memory_id !== "string" ||
      typeof row.event_type !== "string" ||
      typeof row.timestamp !== "string" ||
      typeof row.actor !== "string" ||
      typeof row.rule_version !== "string"
    ) {
      continue;
    }

    let relatedMemoryIds: string[] | undefined;
    if (typeof row.related_memory_ids_json === "string" && row.related_memory_ids_json.length > 0) {
      try {
        const parsed = JSON.parse(row.related_memory_ids_json);
        if (Array.isArray(parsed)) {
          relatedMemoryIds = parsed.filter((value): value is string => typeof value === "string");
        }
      } catch {
        relatedMemoryIds = undefined;
      }
    }

    let before: MemoryLifecycleEvent["before"];
    if (typeof row.before_json === "string" && row.before_json.length > 0) {
      try {
        before = JSON.parse(row.before_json) as MemoryLifecycleEvent["before"];
      } catch {
        before = undefined;
      }
    }

    let after: MemoryLifecycleEvent["after"];
    if (typeof row.after_json === "string" && row.after_json.length > 0) {
      try {
        after = JSON.parse(row.after_json) as MemoryLifecycleEvent["after"];
      } catch {
        after = undefined;
      }
    }

    out.push({
      eventId: row.event_id,
      memoryId: row.memory_id,
      eventType: row.event_type as MemoryLifecycleEvent["eventType"],
      timestamp: row.timestamp,
      actor: row.actor,
      reasonCode: typeof row.reason_code === "string" ? row.reason_code : undefined,
      ruleVersion: row.rule_version,
      relatedMemoryIds,
      before,
      after,
      correlationId: typeof row.correlation_id === "string" ? row.correlation_id : undefined,
    });
  }

  return out;
}

export function readProjectedMemoryState(
  memoryDir: string,
  memoryId: string,
): MemoryProjectionCurrentState | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;

  try {
    const row = db
      .prepare(
        `
          SELECT
            memory_id,
            category,
            status,
            lifecycle_state,
            path_rel,
            created_at,
            updated_at,
            archived_at,
            superseded_at,
            entity_ref,
            source,
            confidence,
            confidence_tier,
            memory_kind,
            access_count,
            last_accessed
          FROM memory_current
          WHERE memory_id = ?
        `,
      )
      .get(memoryId) as Record<string, unknown> | undefined;
    return parseCurrentRow(memoryDir, row);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function readProjectedMemoryTimeline(
  memoryDir: string,
  memoryId: string,
  limit: number,
): MemoryLifecycleEvent[] | null {
  const db = openProjectionReadonly(memoryDir);
  if (!db) return null;

  try {
    const rows = db
      .prepare(
        `
          SELECT * FROM (
            SELECT
              event_id,
              memory_id,
              event_type,
              timestamp,
              event_order,
              actor,
              reason_code,
              rule_version,
              related_memory_ids_json,
              before_json,
              after_json,
              correlation_id
            FROM memory_timeline
            WHERE memory_id = ?
            ORDER BY timestamp DESC, event_order DESC
            LIMIT ?
          )
          ORDER BY timestamp ASC, event_order ASC
        `,
      )
      .all(memoryId, limit) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    return parseTimelineRows(rows);
  } catch {
    return null;
  } finally {
    db.close();
  }
}
