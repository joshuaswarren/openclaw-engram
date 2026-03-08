import path from "node:path";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import type { MemoryLifecycleEvent } from "../types.js";
import {
  buildLifecycleEventsForMemory,
  sortMemoryLifecycleEvents,
} from "../memory-lifecycle-ledger-utils.js";

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

  const events: MemoryLifecycleEvent[] = sortMemoryLifecycleEvents(
    allMemories.flatMap((memory) => buildLifecycleEventsForMemory(memory)),
  );

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
