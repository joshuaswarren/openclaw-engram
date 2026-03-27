import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HourlySummary } from "./types.js";

export const summarySnapshotSchemaVersion = 1;

const SummarySnapshotItemSchema = z.object({
  hour: z.string(),
  sessionKey: z.string(),
  bullets: z.array(z.string()),
  turnCount: z.number().int().nonnegative(),
  generatedAt: z.string(),
});

const SummarySnapshotSchema = z.object({
  schemaVersion: z.number().default(summarySnapshotSchemaVersion),
  sessionKey: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  summaries: z.array(SummarySnapshotItemSchema),
});

type SummarySnapshot = z.infer<typeof SummarySnapshotSchema>;

const summarySnapshotUpserts = new Map<string, Promise<void>>();

export function summarySnapshotPath(
  memoryDir: string,
  sessionKey: string,
): string {
  return path.join(memoryDir, "state", "summaries", `${sessionKey}.json`);
}

export async function readSummarySnapshot(
  memoryDir: string,
  sessionKey: string,
): Promise<HourlySummary[] | null> {
  try {
    const filePath = summarySnapshotPath(memoryDir, sessionKey);
    const raw = await readFile(filePath, "utf-8");
    const data = SummarySnapshotSchema.parse(JSON.parse(raw));
    if (data.sessionKey !== sessionKey) return null;
    return data.summaries;
  } catch {
    return null;
  }
}

export async function writeSummarySnapshot(
  memoryDir: string,
  sessionKey: string,
  summaries: HourlySummary[],
): Promise<void> {
  const filePath = summarySnapshotPath(memoryDir, sessionKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: SummarySnapshot = {
    schemaVersion: summarySnapshotSchemaVersion,
    sessionKey,
    generatedAt: new Date().toISOString(),
    summaries: summaries
      .map((summary) => ({
        hour: summary.hour,
        sessionKey: summary.sessionKey,
        bullets: summary.bullets,
        turnCount: summary.turnCount,
        generatedAt: summary.generatedAt,
      }))
      .sort((a, b) => new Date(b.hour).getTime() - new Date(a.hour).getTime()),
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

async function withSummarySnapshotLock<T>(
  sessionKey: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = summarySnapshotUpserts.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  summarySnapshotUpserts.set(sessionKey, chained);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (summarySnapshotUpserts.get(sessionKey) === chained) {
      summarySnapshotUpserts.delete(sessionKey);
    }
  }
}

export async function upsertSummarySnapshot(
  memoryDir: string,
  summary: HourlySummary,
): Promise<void> {
  await withSummarySnapshotLock(summary.sessionKey, async () => {
    const existing = await readSummarySnapshot(memoryDir, summary.sessionKey);
    const byHour = new Map<string, HourlySummary>();
    for (const item of existing ?? []) {
      byHour.set(item.hour, {
        ...item,
        generatedAt: item.generatedAt || new Date().toISOString(),
        sessionKey: summary.sessionKey,
      });
    }
    byHour.set(summary.hour, summary);
    const next = Array.from(byHour.values()).sort(
      (a, b) => new Date(b.hour).getTime() - new Date(a.hour).getTime(),
    );
    await writeSummarySnapshot(memoryDir, summary.sessionKey, next);
  });
}
