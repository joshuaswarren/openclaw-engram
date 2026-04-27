/**
 * Operator-facing bulk hard-delete (issue #686 retention-completion).
 *
 * `purgeMemories(opts)` hard-deletes memories that are:
 *   - older than `olderThanMs` (measured against `updated ?? created`), AND
 *   - in the specified tier (`"cold"` or `"all"`), AND
 *   - optionally in `status: "forgotten"` only (when `forgottenOnly` is true)
 *
 * Hard-delete means:
 *   1. Remove the file from disk.
 *   2. Trigger a QMD collection update so the index no longer contains it.
 *   3. Append a purge audit entry to the observation ledger.
 *
 * `dryRun: true` (the default) reports what *would* be deleted without
 * actually removing anything — callers must opt into mutations by
 * setting `dryRun: false`.
 *
 * The CLI surface enforces an explicit `--confirm yes` guard and
 * defaults to `--dry-run` to make accidental data loss impossible.
 */

import path from "node:path";
import { appendFile, mkdir, unlink } from "node:fs/promises";
import type { StorageManager } from "../storage.js";
import type { MemoryFile } from "../types.js";
import type { SearchBackend } from "../search/port.js";

export type PurgeTierFilter = "cold" | "all";

export interface PurgeMemoriesOptions {
  storage: StorageManager;
  /**
   * Only memories whose `updated ?? created` timestamp is older than this
   * value (in milliseconds, Unix epoch) will be candidates.
   */
  olderThanMs: number;
  /**
   * `"cold"` — only memories in the cold tier (files under `.../cold/`).
   * `"all"` — memories in any tier (hot, cold, or archived).
   * Default: `"cold"`.
   */
  tier?: PurgeTierFilter;
  /**
   * When `true`, only memories with `status === "forgotten"` are candidates.
   * Default: `false` (purge by age + tier regardless of status).
   */
  forgottenOnly?: boolean;
  /** When `true` (default), report candidates but do not delete. */
  dryRun?: boolean;
  /**
   * Optional QMD backend. When supplied and `dryRun === false`, a
   * `updateCollection` call is issued after each deletion so the index stays
   * consistent. Pass `undefined` or omit to skip index maintenance (e.g. in
   * tests that don't have a live QMD instance).
   */
  qmd?: SearchBackend;
  /** Hot-tier QMD collection name (default: `"openclaw-engram"`). */
  hotCollection?: string;
  /** Cold-tier QMD collection name (default: `"openclaw-engram-cold"`). */
  coldCollection?: string;
  /** Override clock for tests. */
  now?: () => Date;
}

export interface PurgeCandidate {
  id: string;
  path: string;
  tier: "hot" | "cold" | "archive";
  status: string;
  updatedOrCreated: string;
  ageMs: number;
}

export interface PurgeMemoriesResult {
  dryRun: boolean;
  tier: PurgeTierFilter;
  olderThanMs: number;
  candidates: PurgeCandidate[];
  purgedCount: number;
  errorCount: number;
  errors: Array<{ id: string; path: string; error: string }>;
}

function resolveTier(filePath: string): "hot" | "cold" | "archive" {
  const normalized = filePath.split(path.sep).join("/");
  if (normalized.includes("/cold/")) return "cold";
  if (normalized.includes("/archive/")) return "archive";
  return "hot";
}

function resolveTimestamp(memory: MemoryFile): string {
  const fm = memory.frontmatter as unknown as Record<string, unknown>;
  const updated = typeof fm.updated === "string" ? (fm.updated as string) : "";
  const created = typeof fm.created === "string" ? (fm.created as string) : "";
  return updated.length > 0 ? updated : created;
}

async function logPurgeAudit(
  storage: StorageManager,
  candidates: PurgeCandidate[],
  now: Date,
): Promise<void> {
  const ledgerDir = path.join(storage.dir, "state", "observation-ledger");
  await mkdir(ledgerDir, { recursive: true });
  const ledgerPath = path.join(ledgerDir, "purge-audit.jsonl");
  const entries = candidates.map((c) =>
    JSON.stringify({
      event: "PURGE_HARD_DELETE",
      timestamp: now.toISOString(),
      memoryId: c.id,
      path: c.path,
      tier: c.tier,
      status: c.status,
      updatedOrCreated: c.updatedOrCreated,
    }),
  );
  if (entries.length > 0) {
    await appendFile(ledgerPath, `${entries.join("\n")}\n`, "utf-8");
  }
}

export async function purgeMemories(
  options: PurgeMemoriesOptions,
): Promise<PurgeMemoriesResult> {
  const {
    storage,
    olderThanMs,
    tier = "cold",
    forgottenOnly = false,
    dryRun = true,
    qmd,
    hotCollection = "openclaw-engram",
    coldCollection = "openclaw-engram-cold",
  } = options;

  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();

  // Collect all memories from applicable tiers
  const [hotMemories, coldMemories, archivedMemories] = await Promise.all([
    tier === "all" ? storage.readAllMemories() : Promise.resolve([]),
    storage.readAllColdMemories(),
    tier === "all" ? storage.readArchivedMemories() : Promise.resolve([]),
  ]);

  const poolEntries: Array<{ memory: MemoryFile; resolvedTier: "hot" | "cold" | "archive" }> = [];

  if (tier === "all") {
    for (const m of hotMemories) {
      poolEntries.push({ memory: m, resolvedTier: "hot" });
    }
    for (const m of archivedMemories) {
      poolEntries.push({ memory: m, resolvedTier: "archive" });
    }
  }
  for (const m of coldMemories) {
    poolEntries.push({ memory: m, resolvedTier: "cold" });
  }

  // Build candidate list
  const candidates: PurgeCandidate[] = [];
  for (const { memory, resolvedTier } of poolEntries) {
    const ts = resolveTimestamp(memory);
    if (ts.length === 0) continue;

    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs)) continue;

    const ageMs = nowMs - tsMs;
    if (ageMs < olderThanMs) continue;

    const fm = memory.frontmatter as unknown as Record<string, unknown>;
    const status: string =
      typeof fm.status === "string" ? (fm.status as string) : "active";

    if (forgottenOnly && status !== "forgotten") continue;

    candidates.push({
      id: memory.frontmatter.id,
      path: memory.path,
      tier: resolvedTier,
      status,
      updatedOrCreated: ts,
      ageMs,
    });
  }

  if (dryRun) {
    return {
      dryRun: true,
      tier,
      olderThanMs,
      candidates,
      purgedCount: 0,
      errorCount: 0,
      errors: [],
    };
  }

  // Hard-delete phase
  const errors: Array<{ id: string; path: string; error: string }> = [];
  const actuallyPurged: PurgeCandidate[] = [];
  const collectionsToUpdate = new Set<string>();

  for (const candidate of candidates) {
    try {
      await unlink(candidate.path);
      actuallyPurged.push(candidate);
      if (candidate.tier === "cold") {
        collectionsToUpdate.add(coldCollection);
      } else {
        collectionsToUpdate.add(hotCollection);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ENOENT is fine — already gone
      if (!message.includes("ENOENT")) {
        errors.push({ id: candidate.id, path: candidate.path, error: message });
      }
    }
  }

  // Invalidate ALL memory caches — hot and cold — after hard-deleting files.
  //
  // We use StorageManager.clearAllStaticCaches() (the public static surface
  // designed for "files changed outside normal write paths") because:
  //   - invalidateAllMemoriesCacheForDir() only clears the hot cache
  //     (by design — see the UvBq comment in storage.ts)
  //   - invalidateColdMemoriesCache() is private
  //   - purge deletes files directly (like a test writing to disk), so the
  //     static clear is the documented fallback for exactly this situation
  //
  // Fall back to the hot-only public method when storage is a stub (tests).
  const storageClass = (storage as unknown as { constructor: { clearAllStaticCaches?: () => void } }).constructor;
  if (typeof storageClass?.clearAllStaticCaches === "function") {
    storageClass.clearAllStaticCaches();
  } else if (typeof (storage as unknown as { invalidateAllMemoriesCacheForDir?: () => void }).invalidateAllMemoriesCacheForDir === "function") {
    (storage as unknown as { invalidateAllMemoriesCacheForDir: () => void }).invalidateAllMemoriesCacheForDir();
  }

  // Append purge audit to ledger before returning (write rollback data before success marker)
  await logPurgeAudit(storage, actuallyPurged, now);

  // Update QMD index for affected collections
  if (qmd) {
    for (const collection of collectionsToUpdate) {
      try {
        await qmd.updateCollection(collection);
      } catch (indexErr) {
        // Non-fatal — operator can re-index manually
        errors.push({
          id: "(qmd-update)",
          path: collection,
          error: indexErr instanceof Error ? indexErr.message : String(indexErr),
        });
      }
    }
  }

  return {
    dryRun: false,
    tier,
    olderThanMs,
    candidates: actuallyPurged,
    purgedCount: actuallyPurged.length,
    errorCount: errors.length,
    errors,
  };
}
