/**
 * Binary lifecycle manifest — read/write operations.
 *
 * The manifest lives at `${memoryDir}/.binary-lifecycle/manifest.json`.
 * Writes use the atomic temp-then-rename pattern (CLAUDE.md #54).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { BinaryLifecycleManifest } from "./types.js";

const MANIFEST_DIR = ".binary-lifecycle";
const MANIFEST_FILE = "manifest.json";

export function manifestDir(memoryDir: string): string {
  return path.join(memoryDir, MANIFEST_DIR);
}

export function manifestPath(memoryDir: string): string {
  return path.join(memoryDir, MANIFEST_DIR, MANIFEST_FILE);
}

/**
 * Read the manifest from disk. Returns a fresh empty manifest if the file
 * does not exist or contains invalid JSON (CLAUDE.md #18).
 */
export async function readManifest(memoryDir: string): Promise<BinaryLifecycleManifest> {
  const filePath = manifestPath(memoryDir);
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    // CLAUDE.md #18: validate the parsed result is a non-null object.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return emptyManifest();
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== 1 || !Array.isArray(obj.assets)) {
      return emptyManifest();
    }
    return parsed as BinaryLifecycleManifest;
  } catch {
    return emptyManifest();
  }
}

/**
 * Write the manifest atomically: write to a temp file, then rename.
 * CLAUDE.md #54: never delete before write. Write temp first, rename atomically.
 */
export async function writeManifest(
  memoryDir: string,
  manifest: BinaryLifecycleManifest,
): Promise<void> {
  const dir = manifestDir(memoryDir);
  await fsp.mkdir(dir, { recursive: true });
  const dest = manifestPath(memoryDir);
  const tmpSuffix = crypto.randomBytes(8).toString("hex");
  const tmpPath = `${dest}.${tmpSuffix}.tmp`;
  // Sort keys for deterministic output (CLAUDE.md #38).
  const content = JSON.stringify(manifest, null, 2) + "\n";
  await fsp.writeFile(tmpPath, content, "utf-8");
  try {
    await fsp.rename(tmpPath, dest);
  } catch (renameErr) {
    // Clean up temp on rename failure (cross-device edge case).
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw renameErr;
  }
}

export function emptyManifest(): BinaryLifecycleManifest {
  return { version: 1, assets: [] };
}
