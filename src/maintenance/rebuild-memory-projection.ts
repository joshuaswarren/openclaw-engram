import path from "node:path";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import Database from "better-sqlite3";
import { StorageManager } from "../storage.js";
import { toBackupStamp } from "./backup-stamp.js";
import type {
  MemoryFile,
  MemoryLifecycleEvent,
  MemoryProjectionCurrentState,
  MemoryStatus,
} from "../types.js";
import {
  buildLifecycleEventsForMemory,
  inferMemoryStatus,
  MEMORY_LIFECYCLE_EVENT_SORT_ORDER,
  sortMemoryLifecycleEvents,
  toMemoryPathRel,
} from "../memory-lifecycle-ledger-utils.js";
import {
  getMemoryProjectionPath,
  initializeMemoryProjectionDb,
  MEMORY_PROJECTION_SCHEMA_VERSION,
  parseCurrentRow,
  parseTimelineRows,
} from "../memory-projection-store.js";

export interface RebuildMemoryProjectionOptions {
  memoryDir: string;
  dryRun?: boolean;
  now?: Date;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface RebuildMemoryProjectionResult {
  dryRun: boolean;
  scannedMemories: number;
  currentRows: number;
  timelineRows: number;
  outputPath: string;
  backupPath?: string;
  usedLifecycleLedger: boolean;
  scope: {
    updatedAfter: string | null;
    updatedBefore: string | null;
  };
}

export interface VerifyMemoryProjectionOptions {
  memoryDir: string;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface VerifyMemoryProjectionResult {
  outputPath: string;
  projectionExists: boolean;
  ok: boolean;
  expectedCurrentRows: number;
  actualCurrentRows: number;
  expectedTimelineRows: number;
  actualTimelineRows: number;
  missingCurrentMemoryIds: string[];
  extraCurrentMemoryIds: string[];
  mismatchedCurrentMemoryIds: string[];
  missingTimelineEventIds: string[];
  extraTimelineEventIds: string[];
  usedLifecycleLedger: boolean;
  scope: {
    updatedAfter: string | null;
    updatedBefore: string | null;
  };
}

export interface RepairMemoryProjectionOptions extends RebuildMemoryProjectionOptions {}

export interface RepairMemoryProjectionResult {
  dryRun: boolean;
  repaired: boolean;
  verify: VerifyMemoryProjectionResult;
  rebuild?: RebuildMemoryProjectionResult;
}

async function backupExistingProjection(
  memoryDir: string,
  outputPath: string,
  now: Date,
): Promise<string | undefined> {
  try {
    await stat(outputPath);
  } catch {
    return undefined;
  }

  const backupPath = path.join(
    memoryDir,
    "archive",
    "memory-projection",
    toBackupStamp(now),
    "state",
    "memory-projection.sqlite",
  );
  await mkdir(path.dirname(backupPath), { recursive: true });
  await rename(outputPath, backupPath);
  return backupPath;
}

function inferProjectedStatus(pathRel: string, memory: MemoryFile): MemoryStatus {
  return inferMemoryStatus(memory.frontmatter, pathRel);
}

function toCurrentStateRow(memoryDir: string, memory: MemoryFile): MemoryProjectionCurrentState {
  const pathRel = toMemoryPathRel(memoryDir, memory.path);
  return {
    memoryId: memory.frontmatter.id,
    category: memory.frontmatter.category,
    status: inferProjectedStatus(pathRel, memory),
    lifecycleState: memory.frontmatter.lifecycleState,
    path: memory.path,
    pathRel,
    created: memory.frontmatter.created,
    updated: memory.frontmatter.updated,
    archivedAt: memory.frontmatter.archivedAt,
    supersededAt: memory.frontmatter.supersededAt,
    entityRef: memory.frontmatter.entityRef,
    source: memory.frontmatter.source,
    confidence: memory.frontmatter.confidence,
    confidenceTier: memory.frontmatter.confidenceTier,
    memoryKind: memory.frontmatter.memoryKind,
    accessCount: memory.frontmatter.accessCount,
    lastAccessed: memory.frontmatter.lastAccessed,
  };
}

function loadTimelineEvents(
  memories: MemoryFile[],
  lifecycleEvents: MemoryLifecycleEvent[],
): { events: MemoryLifecycleEvent[]; usedLifecycleLedger: boolean } {
  if (lifecycleEvents.length > 0) {
    return {
      events: sortMemoryLifecycleEvents(lifecycleEvents),
      usedLifecycleLedger: true,
    };
  }

  return {
    events: sortMemoryLifecycleEvents(memories.flatMap((memory) => buildLifecycleEventsForMemory(memory))),
    usedLifecycleLedger: false,
  };
}

function normalizeScopedIso(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid projection scope timestamp: ${value}`);
  }
  return parsed.toISOString();
}

function normalizeProjectionScope(options: {
  updatedAfter?: string;
  updatedBefore?: string;
}): {
  updatedAfter: string | null;
  updatedBefore: string | null;
} {
  const updatedAfter = normalizeScopedIso(options.updatedAfter);
  const updatedBefore = normalizeScopedIso(options.updatedBefore);
  if (
    updatedAfter &&
    updatedBefore &&
    new Date(updatedAfter).getTime() > new Date(updatedBefore).getTime()
  ) {
    throw new Error("updatedAfter must be less than or equal to updatedBefore");
  }
  return {
    updatedAfter,
    updatedBefore,
  };
}

function hasScopedProjectionFilter(scope: {
  updatedAfter: string | null;
  updatedBefore: string | null;
}): boolean {
  return scope.updatedAfter !== null || scope.updatedBefore !== null;
}

function memoryScopeTimestamp(memory: MemoryFile): string {
  const candidate = memory.frontmatter.updated || memory.frontmatter.created;
  return candidate;
}

function isTimestampInProjectionScope(
  timestamp: string,
  scope: { updatedAfter: string | null; updatedBefore: string | null },
): boolean {
  if (!scope.updatedAfter && !scope.updatedBefore) return true;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return false;
  if (scope.updatedAfter && parsed.getTime() < new Date(scope.updatedAfter).getTime()) return false;
  if (scope.updatedBefore && parsed.getTime() > new Date(scope.updatedBefore).getTime()) return false;
  return true;
}

function filterMemoriesForProjectionScope(
  memories: MemoryFile[],
  scope: { updatedAfter: string | null; updatedBefore: string | null },
): MemoryFile[] {
  if (!scope.updatedAfter && !scope.updatedBefore) return memories;
  return memories.filter((memory) => isTimestampInProjectionScope(memoryScopeTimestamp(memory), scope));
}

function filterCurrentStateRowsForProjectionScope(
  rows: MemoryProjectionCurrentState[],
  scope: { updatedAfter: string | null; updatedBefore: string | null },
): MemoryProjectionCurrentState[] {
  if (!scope.updatedAfter && !scope.updatedBefore) return rows;
  return rows.filter((row) => isTimestampInProjectionScope(row.updated || row.created, scope));
}

function serializeCurrentStateRow(row: MemoryProjectionCurrentState): string {
  return JSON.stringify({
    memoryId: row.memoryId,
    category: row.category,
    status: row.status,
    lifecycleState: row.lifecycleState ?? null,
    pathRel: row.pathRel,
    created: row.created,
    updated: row.updated,
    archivedAt: row.archivedAt ?? null,
    supersededAt: row.supersededAt ?? null,
    entityRef: row.entityRef ?? null,
    source: row.source,
    confidence: row.confidence,
    confidenceTier: row.confidenceTier,
    memoryKind: row.memoryKind ?? null,
    accessCount: row.accessCount ?? null,
    lastAccessed: row.lastAccessed ?? null,
  });
}

function serializeTimelineEvent(event: MemoryLifecycleEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    memoryId: event.memoryId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    actor: event.actor,
    reasonCode: event.reasonCode ?? null,
    ruleVersion: event.ruleVersion,
    relatedMemoryIds: event.relatedMemoryIds ?? [],
    before: event.before ?? null,
    after: event.after ?? null,
    correlationId: event.correlationId ?? null,
  });
}

async function loadAuthoritativeProjectionSnapshot(options: {
  memoryDir: string;
  updatedAfter?: string;
  updatedBefore?: string;
}): Promise<{
  allMemories: MemoryFile[];
  currentRows: MemoryProjectionCurrentState[];
  timelineRows: MemoryLifecycleEvent[];
  scopedCurrentRows: MemoryProjectionCurrentState[];
  scopedTimelineRows: MemoryLifecycleEvent[];
  usedLifecycleLedger: boolean;
  scope: {
    updatedAfter: string | null;
    updatedBefore: string | null;
  };
}> {
  const storage = new StorageManager(options.memoryDir);
  const allMemories = [...await storage.readAllMemories(), ...await storage.readArchivedMemories()]
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  const lifecycleEvents = await storage.readAllMemoryLifecycleEvents();
  const { events, usedLifecycleLedger } = loadTimelineEvents(allMemories, lifecycleEvents);
  const currentRows = allMemories.map((memory) => toCurrentStateRow(options.memoryDir, memory));
  const scope = normalizeProjectionScope(options);
  const scopedMemories = filterMemoriesForProjectionScope(allMemories, scope);
  const scopedMemoryIds = new Set(scopedMemories.map((memory) => memory.frontmatter.id));

  return {
    allMemories,
    currentRows,
    timelineRows: events,
    scopedCurrentRows: currentRows.filter((row) => scopedMemoryIds.has(row.memoryId)),
    scopedTimelineRows: events.filter((event) => scopedMemoryIds.has(event.memoryId)),
    usedLifecycleLedger,
    scope,
  };
}

function readProjectedCurrentRows(
  memoryDir: string,
): { projectionExists: boolean; rows: MemoryProjectionCurrentState[] } {
  const dbPath = getMemoryProjectionPath(memoryDir);
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`
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
      `).all() as Array<Record<string, unknown>>;

      return {
        projectionExists: true,
        rows: rows
          .map((row) => parseCurrentRow(memoryDir, row))
          .filter((row): row is MemoryProjectionCurrentState => row !== null),
      };
    } finally {
      db.close();
    }
  } catch {
    return { projectionExists: false, rows: [] };
  }
}

function readProjectedTimelineRows(
  memoryDir: string,
): { projectionExists: boolean; rows: MemoryLifecycleEvent[] } {
  const dbPath = getMemoryProjectionPath(memoryDir);
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`
        SELECT
          event_id,
          memory_id,
          event_type,
          timestamp,
          actor,
          reason_code,
          rule_version,
          related_memory_ids_json,
          before_json,
          after_json,
          correlation_id
        FROM memory_timeline
      `).all() as Array<Record<string, unknown>>;

      return {
        projectionExists: true,
        rows: parseTimelineRows(rows),
      };
    } finally {
      db.close();
    }
  } catch {
    return { projectionExists: false, rows: [] };
  }
}

function writeProjectionDb(
  dbPath: string,
  nowIso: string,
  currentRows: MemoryProjectionCurrentState[],
  timelineRows: MemoryLifecycleEvent[],
  usedLifecycleLedger: boolean,
): void {
  const db = new Database(dbPath);
  try {
    initializeMemoryProjectionDb(db);

    const insertMeta = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    insertMeta.run("schemaVersion", String(MEMORY_PROJECTION_SCHEMA_VERSION));
    insertMeta.run("rebuiltAt", nowIso);
    insertMeta.run("usedLifecycleLedger", usedLifecycleLedger ? "true" : "false");

    const insertCurrent = db.prepare(`
      INSERT INTO memory_current (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTimeline = db.prepare(`
      INSERT INTO memory_timeline (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const writeTx = db.transaction(() => {
      for (const row of currentRows) {
        insertCurrent.run(
          row.memoryId,
          row.category,
          row.status,
          row.lifecycleState ?? null,
          row.pathRel,
          row.created,
          row.updated,
          row.archivedAt ?? null,
          row.supersededAt ?? null,
          row.entityRef ?? null,
          row.source,
          row.confidence,
          row.confidenceTier,
          row.memoryKind ?? null,
          row.accessCount ?? null,
          row.lastAccessed ?? null,
        );
      }

      for (const event of timelineRows) {
        insertTimeline.run(
          event.eventId,
          event.memoryId,
          event.eventType,
          event.timestamp,
          MEMORY_LIFECYCLE_EVENT_SORT_ORDER[event.eventType],
          event.actor,
          event.reasonCode ?? null,
          event.ruleVersion,
          JSON.stringify(event.relatedMemoryIds ?? []),
          event.before ? JSON.stringify(event.before) : null,
          event.after ? JSON.stringify(event.after) : null,
          event.correlationId ?? null,
        );
      }
    });

    writeTx();
  } finally {
    db.close();
  }
}

function mergeScopedCurrentRows(
  existingRows: MemoryProjectionCurrentState[],
  replacementRows: MemoryProjectionCurrentState[],
  scopedMemoryIds: Set<string>,
): MemoryProjectionCurrentState[] {
  return [...existingRows.filter((row) => !scopedMemoryIds.has(row.memoryId)), ...replacementRows]
    .sort((a, b) => a.memoryId.localeCompare(b.memoryId));
}

function mergeScopedTimelineRows(
  existingRows: MemoryLifecycleEvent[],
  replacementRows: MemoryLifecycleEvent[],
  scopedMemoryIds: Set<string>,
): MemoryLifecycleEvent[] {
  return sortMemoryLifecycleEvents([
    ...existingRows.filter((event) => !scopedMemoryIds.has(event.memoryId)),
    ...replacementRows,
  ]);
}

export async function rebuildMemoryProjection(
  options: RebuildMemoryProjectionOptions,
): Promise<RebuildMemoryProjectionResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const outputPath = getMemoryProjectionPath(options.memoryDir);
  const snapshot = await loadAuthoritativeProjectionSnapshot(options);

  let backupPath: string | undefined;
  if (!dryRun) {
    let nextCurrentRows = snapshot.currentRows;
    let nextTimelineRows = snapshot.timelineRows;
    if (hasScopedProjectionFilter(snapshot.scope)) {
      const projectedCurrent = readProjectedCurrentRows(options.memoryDir);
      const projectedTimeline = readProjectedTimelineRows(options.memoryDir);
      if (projectedCurrent.projectionExists && projectedTimeline.projectionExists) {
        const actualScopedCurrentRows = filterCurrentStateRowsForProjectionScope(
          projectedCurrent.rows,
          snapshot.scope,
        );
        const scopedMemoryIds = new Set([
          ...snapshot.scopedCurrentRows.map((row) => row.memoryId),
          ...snapshot.scopedTimelineRows.map((event) => event.memoryId),
          ...actualScopedCurrentRows.map((row) => row.memoryId),
        ]);
        nextCurrentRows = mergeScopedCurrentRows(
          projectedCurrent.rows,
          snapshot.scopedCurrentRows,
          scopedMemoryIds,
        );
        nextTimelineRows = mergeScopedTimelineRows(
          projectedTimeline.rows,
          snapshot.scopedTimelineRows,
          scopedMemoryIds,
        );
      }
    }

    const tempPath = `${outputPath}.tmp`;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await rm(tempPath, { force: true });
    writeProjectionDb(
      tempPath,
      now.toISOString(),
      nextCurrentRows,
      nextTimelineRows,
      snapshot.usedLifecycleLedger,
    );
    backupPath = await backupExistingProjection(options.memoryDir, outputPath, now);
    await rename(tempPath, outputPath);
  }

  return {
    dryRun,
    scannedMemories: snapshot.allMemories.length,
    currentRows: snapshot.scopedCurrentRows.length,
    timelineRows: snapshot.scopedTimelineRows.length,
    outputPath,
    backupPath,
    usedLifecycleLedger: snapshot.usedLifecycleLedger,
    scope: snapshot.scope,
  };
}

export async function verifyMemoryProjection(
  options: VerifyMemoryProjectionOptions,
): Promise<VerifyMemoryProjectionResult> {
  const outputPath = getMemoryProjectionPath(options.memoryDir);
  const snapshot = await loadAuthoritativeProjectionSnapshot(options);
  const projectedCurrent = readProjectedCurrentRows(options.memoryDir);
  const projectedTimeline = readProjectedTimelineRows(options.memoryDir);
  const projectionExists = projectedCurrent.projectionExists || projectedTimeline.projectionExists;

  const actualScopedCurrentRows = filterCurrentStateRowsForProjectionScope(projectedCurrent.rows, snapshot.scope);
  const expectedCurrentById = new Map(
    snapshot.scopedCurrentRows.map((row) => [row.memoryId, serializeCurrentStateRow(row)]),
  );
  const actualCurrentById = new Map(
    actualScopedCurrentRows.map((row) => [row.memoryId, serializeCurrentStateRow(row)]),
  );

  const missingCurrentMemoryIds = [...expectedCurrentById.keys()]
    .filter((memoryId) => !actualCurrentById.has(memoryId))
    .sort();
  const extraCurrentMemoryIds = [...actualCurrentById.keys()]
    .filter((memoryId) => !expectedCurrentById.has(memoryId))
    .sort();
  const mismatchedCurrentMemoryIds = [...expectedCurrentById.keys()]
    .filter((memoryId) =>
      actualCurrentById.has(memoryId) && actualCurrentById.get(memoryId) !== expectedCurrentById.get(memoryId)
    )
    .sort();

  const selectedMemoryIds = new Set([
    ...snapshot.scopedCurrentRows.map((row) => row.memoryId),
    ...actualScopedCurrentRows.map((row) => row.memoryId),
  ]);
  const expectedTimelineById = new Map(
    snapshot.scopedTimelineRows.map((event) => [event.eventId, serializeTimelineEvent(event)]),
  );
  const actualTimelineRows = projectedTimeline.rows.filter((event) => selectedMemoryIds.has(event.memoryId));
  const actualTimelineById = new Map(
    actualTimelineRows.map((event) => [event.eventId, serializeTimelineEvent(event)]),
  );
  const missingTimelineEventIds = [...expectedTimelineById.keys()]
    .filter((eventId) => !actualTimelineById.has(eventId))
    .sort();
  const extraTimelineEventIds = [...actualTimelineById.keys()]
    .filter((eventId) => !expectedTimelineById.has(eventId))
    .sort();

  return {
    outputPath,
    projectionExists,
    ok:
      projectionExists &&
      missingCurrentMemoryIds.length === 0 &&
      extraCurrentMemoryIds.length === 0 &&
      mismatchedCurrentMemoryIds.length === 0 &&
      missingTimelineEventIds.length === 0 &&
      extraTimelineEventIds.length === 0,
    expectedCurrentRows: snapshot.scopedCurrentRows.length,
    actualCurrentRows: actualScopedCurrentRows.length,
    expectedTimelineRows: snapshot.scopedTimelineRows.length,
    actualTimelineRows: actualTimelineRows.length,
    missingCurrentMemoryIds,
    extraCurrentMemoryIds,
    mismatchedCurrentMemoryIds,
    missingTimelineEventIds,
    extraTimelineEventIds,
    usedLifecycleLedger: snapshot.usedLifecycleLedger,
    scope: snapshot.scope,
  };
}

export async function repairMemoryProjection(
  options: RepairMemoryProjectionOptions,
): Promise<RepairMemoryProjectionResult> {
  const dryRun = options.dryRun !== false;
  const verify = await verifyMemoryProjection(options);
  if (verify.ok) {
    return {
      dryRun,
      repaired: false,
      verify,
    };
  }
  if (dryRun) {
    return {
      dryRun: true,
      repaired: false,
      verify,
    };
  }

  const rebuild = await rebuildMemoryProjection({
    ...options,
    dryRun: false,
  });
  const verified = await verifyMemoryProjection(options);
  return {
    dryRun: false,
    repaired: verified.ok,
    verify: verified,
    rebuild,
  };
}
