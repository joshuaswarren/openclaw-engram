/**
 * Binary lifecycle pipeline — mirror, redirect, clean.
 *
 * Three-stage pipeline:
 * 1. Mirror:   upload binary to backend, record in manifest
 * 2. Redirect: scan markdown for inline refs, replace with redirect path
 * 3. Clean:    after grace period, delete local copy
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  BinaryAssetRecord,
  BinaryLifecycleConfig,
  PipelineResult,
} from "./types.js";
import type { BinaryStorageBackend } from "./backend.js";
import { readManifest, writeManifest } from "./manifest.js";
import { scanForBinaries } from "./scanner.js";

/** Minimal logger interface so we don't depend on the full logger module. */
interface PipelineLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface PipelineOptions {
  dryRun?: boolean;
  /** Force-clean all files past grace period, ignoring redirect status. */
  forceClean?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashFile(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function guessMimeType(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Escape special regex characters in a string.
 * CLAUDE.md #46: always escapeRegex on user-derived parts.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

async function stageMirror(
  memoryDir: string,
  newPaths: string[],
  backend: BinaryStorageBackend,
  assets: BinaryAssetRecord[],
  log: PipelineLogger,
  dryRun: boolean,
): Promise<{ mirrored: number; errors: string[] }> {
  let mirrored = 0;
  const errors: string[] = [];

  for (const relPath of newPaths) {
    const fullPath = path.join(memoryDir, relPath);
    try {
      const stat = await fsp.stat(fullPath);
      const contentHash = await hashFile(fullPath);
      const ext = path.extname(relPath);
      const mimeType = guessMimeType(ext);
      const remotePath = relPath;

      if (!dryRun) {
        await backend.upload(fullPath, remotePath);
      }

      const record: BinaryAssetRecord = {
        originalPath: relPath,
        mirroredPath: remotePath,
        contentHash,
        sizeBytes: stat.size,
        mimeType,
        mirroredAt: new Date().toISOString(),
        status: "mirrored",
      };

      assets.push(record);
      mirrored++;
      log.info(`[binary-lifecycle] mirrored: ${relPath} (${stat.size} bytes)${dryRun ? " [dry-run]" : ""}`);
    } catch (err) {
      const msg = `mirror failed for ${relPath}: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[binary-lifecycle] ${msg}`);
      errors.push(msg);
    }
  }

  return { mirrored, errors };
}

async function stageRedirect(
  memoryDir: string,
  assets: BinaryAssetRecord[],
  log: PipelineLogger,
  dryRun: boolean,
): Promise<{ redirected: number; errors: string[] }> {
  let redirected = 0;
  const errors: string[] = [];

  // Only redirect assets that are mirrored but not yet redirected.
  const candidates = assets.filter((a) => a.status === "mirrored");
  if (candidates.length === 0) return { redirected, errors };

  // Find all markdown files in memoryDir (recursive).
  const mdFiles = await findMarkdownFiles(memoryDir);

  for (const asset of candidates) {
    let found = false;
    for (const mdPath of mdFiles) {
      try {
        const content = await fsp.readFile(mdPath, "utf-8");
        // Build a regex that matches markdown image/link references to the file.
        // Handles: ![alt](./path) , ![alt](path) , [text](./path)
        const escaped = escapeRegex(asset.originalPath);
        const pattern = new RegExp(
          `(!?\\[[^\\]]*\\]\\()(\\.\\/)?(${escaped})(\\))`,
          "g",
        );

        if (!pattern.test(content)) continue;
        found = true;

        if (!dryRun) {
          // Reset lastIndex after test().
          pattern.lastIndex = 0;
          const updated = content.replace(pattern, (_match, open, _dotSlash, _file, close) => {
            return `${open as string}${asset.mirroredPath}${close as string}`;
          });
          await fsp.writeFile(mdPath, updated, "utf-8");
        }
      } catch (err) {
        const msg = `redirect scan failed for ${mdPath}: ${err instanceof Error ? err.message : String(err)}`;
        log.error(`[binary-lifecycle] ${msg}`);
        errors.push(msg);
      }
    }

    if (found) {
      asset.status = "redirected";
      asset.redirectedAt = new Date().toISOString();
      redirected++;
      log.info(`[binary-lifecycle] redirected: ${asset.originalPath}${dryRun ? " [dry-run]" : ""}`);
    }
  }

  return { redirected, errors };
}

async function stageClean(
  memoryDir: string,
  assets: BinaryAssetRecord[],
  gracePeriodDays: number,
  log: PipelineLogger,
  dryRun: boolean,
  forceClean: boolean,
): Promise<{ cleaned: number; errors: string[] }> {
  let cleaned = 0;
  const errors: string[] = [];
  const now = Date.now();
  const graceMs = gracePeriodDays * 24 * 60 * 60 * 1000;

  // Clean assets that have been mirrored or redirected and are past grace period.
  const candidates = assets.filter(
    (a) => a.status === "mirrored" || a.status === "redirected",
  );

  for (const asset of candidates) {
    const mirroredMs = new Date(asset.mirroredAt).getTime();
    const ageMs = now - mirroredMs;

    if (!forceClean && ageMs < graceMs) {
      // Not yet past grace period.
      continue;
    }

    const fullPath = path.join(memoryDir, asset.originalPath);
    try {
      if (!dryRun) {
        await fsp.unlink(fullPath);
      }
      asset.status = "cleaned";
      asset.cleanedAt = new Date().toISOString();
      cleaned++;
      log.info(`[binary-lifecycle] cleaned: ${asset.originalPath}${dryRun ? " [dry-run]" : ""}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Already gone — mark as cleaned.
        asset.status = "cleaned";
        asset.cleanedAt = new Date().toISOString();
        cleaned++;
      } else {
        const msg = `clean failed for ${asset.originalPath}: ${err instanceof Error ? err.message : String(err)}`;
        log.error(`[binary-lifecycle] ${msg}`);
        errors.push(msg);
      }
    }
  }

  return { cleaned, errors };
}

// ---------------------------------------------------------------------------
// Markdown file discovery
// ---------------------------------------------------------------------------

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".binary-lifecycle") continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the binary lifecycle pipeline: scan, mirror, redirect, clean.
 */
export async function runBinaryLifecyclePipeline(
  memoryDir: string,
  config: BinaryLifecycleConfig,
  backend: BinaryStorageBackend,
  log: PipelineLogger,
  opts?: PipelineOptions,
): Promise<PipelineResult> {
  const dryRun = opts?.dryRun ?? false;
  const forceClean = opts?.forceClean ?? false;

  const manifest = await readManifest(memoryDir);

  // Stage 0: Scan
  const newPaths = await scanForBinaries(memoryDir, config, manifest);
  const scanned = newPaths.length;

  // Stage 1: Mirror
  const mirrorResult = await stageMirror(
    memoryDir,
    newPaths,
    backend,
    manifest.assets,
    log,
    dryRun,
  );

  // Stage 2: Redirect
  const redirectResult = await stageRedirect(memoryDir, manifest.assets, log, dryRun);

  // Stage 3: Clean
  const cleanResult = await stageClean(
    memoryDir,
    manifest.assets,
    config.gracePeriodDays,
    log,
    dryRun,
    forceClean,
  );

  // Persist manifest (unless dry-run).
  manifest.lastScanAt = new Date().toISOString();
  if (!dryRun) {
    await writeManifest(memoryDir, manifest);
  }

  const allErrors = [
    ...mirrorResult.errors,
    ...redirectResult.errors,
    ...cleanResult.errors,
  ];

  return {
    scanned,
    mirrored: mirrorResult.mirrored,
    redirected: redirectResult.redirected,
    cleaned: cleanResult.cleaned,
    errors: allErrors,
    dryRun,
  };
}
