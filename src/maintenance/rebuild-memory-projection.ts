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
  MEMORY_LIFECYCLE_EVENT_SORT_ORDER,
  sortMemoryLifecycleEvents,
} from "../memory-lifecycle-ledger-utils.js";
import {
  getMemoryProjectionPath,
  initializeMemoryProjectionDb,
  MEMORY_PROJECTION_SCHEMA_VERSION,
} from "../memory-projection-store.js";

export interface RebuildMemoryProjectionOptions {
  memoryDir: string;
  dryRun?: boolean;
  now?: Date;
}

export interface RebuildMemoryProjectionResult {
  dryRun: boolean;
  scannedMemories: number;
  currentRows: number;
  timelineRows: number;
  outputPath: string;
  backupPath?: string;
  usedLifecycleLedger: boolean;
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

function toProjectionPathRel(memoryDir: string, memoryPath: string): string {
  return path.relative(memoryDir, memoryPath).split(path.sep).join("/");
}

function inferProjectedStatus(pathRel: string, memory: MemoryFile): MemoryStatus {
  if (memory.frontmatter.status && memory.frontmatter.status !== "active") return memory.frontmatter.status;
  if (memory.frontmatter.archivedAt) return "archived";
  if (pathRel.startsWith("archive/")) return "archived";
  if (memory.frontmatter.status) return memory.frontmatter.status;
  return "active";
}

function toCurrentStateRow(memoryDir: string, memory: MemoryFile): MemoryProjectionCurrentState {
  const pathRel = toProjectionPathRel(memoryDir, memory.path);
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

export async function rebuildMemoryProjection(
  options: RebuildMemoryProjectionOptions,
): Promise<RebuildMemoryProjectionResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const storage = new StorageManager(options.memoryDir);
  const outputPath = getMemoryProjectionPath(options.memoryDir);
  const allMemories = [...await storage.readAllMemories(), ...await storage.readArchivedMemories()]
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  const lifecycleEvents = await storage.readAllMemoryLifecycleEvents();
  const { events, usedLifecycleLedger } = loadTimelineEvents(allMemories, lifecycleEvents);
  const currentRows = allMemories.map((memory) => toCurrentStateRow(options.memoryDir, memory));

  let backupPath: string | undefined;
  if (!dryRun) {
    const tempPath = `${outputPath}.tmp`;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await rm(tempPath, { force: true });
    writeProjectionDb(
      tempPath,
      now.toISOString(),
      currentRows,
      events,
      usedLifecycleLedger,
    );
    backupPath = await backupExistingProjection(options.memoryDir, outputPath, now);
    await rename(tempPath, outputPath);
  }

  return {
    dryRun,
    scannedMemories: allMemories.length,
    currentRows: currentRows.length,
    timelineRows: events.length,
    outputPath,
    backupPath,
    usedLifecycleLedger,
  };
}
