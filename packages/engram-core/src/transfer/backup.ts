import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { exportMarkdownBundle } from "./export-md.js";

export interface BackupOptions {
  memoryDir: string;
  outDir: string;
  includeTranscripts?: boolean;
  retentionDays?: number;
  pluginVersion: string;
}

function timestampDirName(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function backupMemoryDir(opts: BackupOptions): Promise<string> {
  const outDirAbs = path.resolve(opts.outDir);
  await mkdir(outDirAbs, { recursive: true });
  const ts = timestampDirName(new Date());
  const backupDir = path.join(outDirAbs, ts);

  await exportMarkdownBundle({
    memoryDir: opts.memoryDir,
    outDir: backupDir,
    includeTranscripts: opts.includeTranscripts,
    pluginVersion: opts.pluginVersion,
  });

  if (opts.retentionDays && opts.retentionDays > 0) {
    await enforceRetention(outDirAbs, opts.retentionDays);
  }

  return backupDir;
}

async function enforceRetention(outDirAbs: string, retentionDays: number): Promise<void> {
  const entries = await readdir(outDirAbs, { withFileTypes: true });
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    // Directory names are ISO8601 with [: .] replaced by "-" to be filesystem-friendly.
    // Example: 2026-02-11T05-06-07-123Z => 2026-02-11T05:06:07.123Z
    const m = name.match(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    );
    const iso = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
    const tsMs = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < cutoffMs) {
      await rm(path.join(outDirAbs, name), { recursive: true, force: true });
    }
  }
}
