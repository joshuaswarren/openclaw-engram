import path from "node:path";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import type {
  MemoryFile,
  MemoryLifecycleEvent,
  MemoryLifecycleEventType,
  MemoryLifecycleStateSummary,
} from "../types.js";

export interface RebuildMemoryLifecycleLedgerOptions {
  memoryDir: string;
  dryRun?: boolean;
  now?: Date;
}

export interface RebuildMemoryLifecycleLedgerResult {
  dryRun: boolean;
  scannedMemories: number;
  rebuiltRows: number;
  outputPath: string;
  backupPath?: string;
}

function summarize(memory: MemoryFile): MemoryLifecycleStateSummary {
  return {
    category: memory.frontmatter.category,
    path: memory.path,
    status: memory.frontmatter.status ?? "active",
    lifecycleState: memory.frontmatter.lifecycleState,
  };
}

function makeEvent(
  memory: MemoryFile,
  eventType: MemoryLifecycleEventType,
  timestamp: string,
): MemoryLifecycleEvent {
  return {
    eventId: `rebuild-${memory.frontmatter.id}-${eventType}-${timestamp}`,
    memoryId: memory.frontmatter.id,
    eventType,
    timestamp,
    actor: "maintenance.rebuildMemoryLifecycleLedger",
    ruleVersion: "memory-lifecycle-ledger.v1",
    after: summarize(memory),
    relatedMemoryIds: [
      ...(memory.frontmatter.supersededBy ? [memory.frontmatter.supersededBy] : []),
      ...(memory.frontmatter.supersedes ? [memory.frontmatter.supersedes] : []),
      ...((memory.frontmatter.lineage ?? []).filter(Boolean)),
    ],
  };
}

function buildEventsForMemory(memory: MemoryFile): MemoryLifecycleEvent[] {
  const events: MemoryLifecycleEvent[] = [];
  const created = memory.frontmatter.created;
  const updated = memory.frontmatter.updated;
  const archivedAt = memory.frontmatter.archivedAt;
  const supersededAt = memory.frontmatter.supersededAt;
  const statusTransitionTimestamp = archivedAt ?? supersededAt;

  events.push(makeEvent(memory, "created", created));
  if (updated && updated !== created && updated !== statusTransitionTimestamp) {
    events.push(makeEvent(memory, "updated", updated));
  }
  if (supersededAt) {
    events.push(makeEvent(memory, "superseded", supersededAt));
  }
  if (archivedAt || (memory.frontmatter.status === "archived" && updated)) {
    events.push(makeEvent(memory, "archived", archivedAt ?? updated));
  }

  return events;
}

function toBackupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function backupExistingLedger(
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
    "memory-lifecycle-ledger",
    toBackupStamp(now),
    "state",
    "memory-lifecycle-ledger.jsonl",
  );
  await mkdir(path.dirname(backupPath), { recursive: true });
  await rename(outputPath, backupPath);
  return backupPath;
}

export async function rebuildMemoryLifecycleLedger(
  options: RebuildMemoryLifecycleLedgerOptions,
): Promise<RebuildMemoryLifecycleLedgerResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const outputPath = path.join(options.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  const storage = new StorageManager(options.memoryDir);
  const allMemories = [...await storage.readAllMemories(), ...await storage.readArchivedMemories()]
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));

  const events = allMemories
    .flatMap((memory) => buildEventsForMemory(memory))
    .sort((a, b) => {
      if (a.memoryId !== b.memoryId) return a.memoryId.localeCompare(b.memoryId);
      if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
      return a.eventType.localeCompare(b.eventType);
    });

  let backupPath: string | undefined;
  if (!dryRun) {
    backupPath = await backupExistingLedger(options.memoryDir, outputPath, now);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const payload = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(outputPath, payload.length > 0 ? `${payload}\n` : "", "utf-8");
  }

  return {
    dryRun,
    scannedMemories: allMemories.length,
    rebuiltRows: events.length,
    outputPath,
    backupPath,
  };
}
