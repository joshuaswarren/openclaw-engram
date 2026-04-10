import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileExists, listFilesRecursive, toPosixRelPath, fromPosixRelPath } from "./fs-utils.js";

export type ConflictPolicy = "skip" | "overwrite" | "dedupe";

export interface ImportMdOptions {
  targetMemoryDir: string;
  fromDir: string;
  conflict?: ConflictPolicy;
  dryRun?: boolean;
}

function normalizeForDedupe(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function importMarkdownBundle(opts: ImportMdOptions): Promise<{ written: number; skipped: number }> {
  const conflict = opts.conflict ?? "skip";
  const fromAbs = path.resolve(opts.fromDir);
  const targetAbs = path.resolve(opts.targetMemoryDir);

  const filesAbs = await listFilesRecursive(fromAbs);
  const writes: Array<{ abs: string; content: string }> = [];
  let skipped = 0;

  for (const abs of filesAbs) {
    const relPosix = toPosixRelPath(abs, fromAbs);
    if (relPosix === "manifest.json") continue;
    const dstAbs = path.join(targetAbs, fromPosixRelPath(relPosix));
    const content = await readFile(abs, "utf-8");

    const exists = await fileExists(dstAbs);
    if (exists) {
      if (conflict === "skip") {
        skipped += 1;
        continue;
      }
      if (conflict === "dedupe") {
        try {
          const existing = await (await import("node:fs/promises")).readFile(dstAbs, "utf-8");
          if (normalizeForDedupe(existing) === normalizeForDedupe(content)) {
            skipped += 1;
            continue;
          }
        } catch {
          // fall through to overwrite
        }
      }
    }

    writes.push({ abs: dstAbs, content });
  }

  if (opts.dryRun) return { written: 0, skipped };

  for (const w of writes) {
    await mkdir(path.dirname(w.abs), { recursive: true });
    await writeFile(w.abs, w.content, "utf-8");
  }

  return { written: writes.length, skipped };
}

