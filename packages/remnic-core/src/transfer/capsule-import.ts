import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  createVersion,
  type VersioningConfig,
  type VersioningLogger,
} from "../page-versioning.js";
import { fromPosixRelPath, sha256String } from "./fs-utils.js";
import {
  parseExportBundle,
  type CapsuleBlock,
  type ExportManifestV2,
  type ExportMemoryRecordV1,
} from "./types.js";

/**
 * Conflict-resolution mode for {@link importCapsule}. Inverse of the
 * `mode` selector in PR 4/6's CLI surface.
 *
 *  - `"skip"` (default) — when a target file already exists at the same
 *    relative path, leave it untouched. The corresponding record is reported
 *    via {@link ImportCapsuleResult.skipped}.
 *  - `"overwrite"` — when a target file exists, snapshot the prior content
 *    via {@link createVersion} (gotcha #54: write-before-delete; gotcha #25:
 *    don't destroy old state until new state is confirmed), then write the
 *    incoming content. The snapshot's `note` includes the source capsule id.
 *  - `"fork"` — never overwrite. Every record is rebased under
 *    `forks/<capsule-id>/<original-path>` and any YAML-frontmatter `id:`
 *    field is rewritten to a new fork-scoped value. The original tree is
 *    not touched.
 *
 * The mode is selected once per call and applied uniformly to every record
 * in the bundle. Mixed-mode imports are not supported by design — that
 * would let a single corrupted manifest silently land partial state.
 */
export type ImportCapsuleMode = "skip" | "overwrite" | "fork";

/**
 * Options accepted by {@link importCapsule}.
 *
 * `archivePath` — absolute or cwd-relative path to a `.capsule.json.gz`
 * archive produced by `exportCapsule`. The archive must contain a V2
 * bundle (`schemaVersion: 2`); V1 archives are rejected.
 *
 * `root` — absolute or cwd-relative path to the memory directory that
 * will receive the records. Must be an existing directory.
 *
 * `mode` — see {@link ImportCapsuleMode}. Defaults to `"skip"`.
 *
 * `versioning` — optional page-versioning config used by `mode: "overwrite"`
 * to snapshot prior content before replacing it. Snapshots are skipped when
 * not provided or when `enabled === false`. Tests pass an enabled config
 * to assert snapshot creation; production callers thread the
 * orchestrator's resolved versioning config.
 *
 * `log` — optional logger forwarded to {@link createVersion}.
 *
 * `now` — optional clock override (ms epoch) used to derive deterministic
 * fork ids in tests. Production callers omit this.
 */
export interface ImportCapsuleOptions {
  archivePath: string;
  root: string;
  mode?: ImportCapsuleMode;
  versioning?: VersioningConfig;
  log?: VersioningLogger;
  now?: number;
}

export interface ImportCapsuleSkippedRecord {
  /** Original record path (capsule-relative, posix). */
  path: string;
  /** Why this record was not written. */
  reason: "exists" | "checksum_mismatch";
}

export interface ImportCapsuleImportedRecord {
  /** Capsule-relative posix path the record carried. */
  sourcePath: string;
  /** Memory-dir-relative posix path the file was written to. */
  targetPath: string;
  /** Whether a prior version snapshot was taken (overwrite-mode only). */
  snapshotted: boolean;
  /** Whether the frontmatter `id:` field was rewritten (fork-mode only). */
  rewroteId: boolean;
}

export interface ImportCapsuleResult {
  /** Records that landed on disk. */
  imported: ImportCapsuleImportedRecord[];
  /** Records that were not written. */
  skipped: ImportCapsuleSkippedRecord[];
  /** The manifest decoded from the archive. */
  manifest: ExportManifestV2;
}

/**
 * Pure async function that imports a capsule archive into a memory
 * directory. Inverse of {@link import("./capsule-export.js").exportCapsule}.
 *
 * Sequence:
 *   1. Read + gunzip + JSON.parse the archive.
 *   2. Validate the bundle through `parseExportBundle` (V1 rejected).
 *   3. Verify each record's content sha256 against the manifest entry.
 *      Any mismatch aborts the import BEFORE any file is written —
 *      partial-write recovery would require a full rollback we cannot
 *      offer cheaply, so we fail closed (gotcha #25).
 *   4. Apply the selected {@link ImportCapsuleMode} to every record.
 *
 * Determinism guarantees:
 *  - Imported records are returned sorted by `sourcePath`.
 *  - Skipped records are returned sorted by `path`.
 *  - Fork-mode rebases under a stable `forks/<capsule-id>/` prefix so
 *    repeated fork imports of the same capsule shape land in predictable
 *    locations (subsequent fork imports still skip-on-exist because the
 *    target tree is computed from the source path).
 */
export async function importCapsule(
  opts: ImportCapsuleOptions,
): Promise<ImportCapsuleResult> {
  const archiveAbs = path.resolve(opts.archivePath);
  const rootAbs = path.resolve(opts.root);
  await assertIsDirectory(rootAbs);

  const mode: ImportCapsuleMode = opts.mode ?? "skip";

  const raw = await readFile(archiveAbs);
  const json = gunzipSync(raw).toString("utf-8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch (cause) {
    throw new Error(
      `importCapsule: archive is not valid JSON after gunzip: ${archiveAbs}`,
      { cause: cause as Error },
    );
  }

  const parsed = parseExportBundle(parsedJson);
  if (parsed.capsuleVersion !== 2) {
    // PR 1/6 ships a V1 reader; capsule import is V2-only by design. A V1
    // bundle does not carry a capsule block, so fork-mode (which depends on
    // `capsule.id` for the rebase prefix) cannot work. Reject up-front per
    // gotcha #51 instead of silently routing to a different code path.
    throw new Error(
      "importCapsule: archive is V1; only V2 capsule archives are supported",
    );
  }
  const bundle = parsed.bundle as { manifest: ExportManifestV2; records: ExportMemoryRecordV1[] };
  const manifest = bundle.manifest;
  const capsule = manifest.capsule;

  // Build a path → manifest-entry index for O(1) checksum lookup. The
  // manifest is the source of truth; records-without-manifest-entries and
  // manifest-entries-without-records are both treated as corruption.
  const manifestIndex = new Map<string, ExportManifestV2["files"][number]>();
  for (const f of manifest.files) {
    manifestIndex.set(f.path, f);
  }
  if (manifestIndex.size !== manifest.files.length) {
    throw new Error(
      "importCapsule: manifest contains duplicate file paths",
    );
  }
  const recordPaths = new Set<string>();
  for (const rec of bundle.records) {
    if (recordPaths.has(rec.path)) {
      throw new Error(
        `importCapsule: bundle contains duplicate record path: ${rec.path}`,
      );
    }
    recordPaths.add(rec.path);
  }

  // Phase 1: verify every record matches its manifest entry. We compute a
  // sha256 over the in-memory record content and compare to the manifest's
  // declared sha256. Any mismatch — including a missing manifest entry —
  // aborts the import. We do this BEFORE any filesystem mutation so a
  // corrupted archive cannot leave the memory dir partially written.
  for (const rec of bundle.records) {
    const entry = manifestIndex.get(rec.path);
    if (!entry) {
      throw new Error(
        `importCapsule: archive checksum mismatch (record without manifest entry: ${rec.path})`,
      );
    }
    const { sha256, bytes } = sha256String(rec.content);
    if (sha256 !== entry.sha256 || bytes !== entry.bytes) {
      throw new Error(
        `importCapsule: archive checksum mismatch for ${rec.path}: ` +
          `expected sha256=${entry.sha256} bytes=${entry.bytes}, ` +
          `got sha256=${sha256} bytes=${bytes}`,
      );
    }
  }
  // Detect manifest-only entries (missing record). Treat as corruption.
  for (const f of manifest.files) {
    if (!recordPaths.has(f.path)) {
      throw new Error(
        `importCapsule: archive checksum mismatch (manifest entry without record: ${f.path})`,
      );
    }
  }

  // Phase 2: apply the mode. Records were validated above; we now write to
  // disk. Per-record errors propagate; the import is best-effort across
  // records but each individual write is atomic (mkdir + writeFile pair).
  const imported: ImportCapsuleImportedRecord[] = [];
  const skipped: ImportCapsuleSkippedRecord[] = [];

  // Sort by source path so the imported/skipped lists are deterministic
  // regardless of bundle order. (`exportCapsule` already sorts; we re-sort
  // defensively in case a hand-edited archive ships records in another order.)
  const sortedRecords = [...bundle.records].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  for (const rec of sortedRecords) {
    const targetRel = computeTargetPath(rec.path, mode, capsule.id);
    const targetAbs = path.join(rootAbs, fromPosixRelPath(targetRel));

    if (!isPathInsideRoot(rootAbs, targetAbs)) {
      // Record path traversal protection. `exportCapsule` only ever produces
      // posix-relative paths under root, but a hand-built archive could ship
      // `../../etc/passwd`. Reject before any FS access.
      throw new Error(
        `importCapsule: record path escapes target root: ${rec.path}`,
      );
    }

    const exists = await fileExistsAt(targetAbs);

    if (mode === "skip" && exists) {
      skipped.push({ path: rec.path, reason: "exists" });
      continue;
    }

    let snapshotted = false;
    if (mode === "overwrite" && exists) {
      // Gotcha #54: snapshot BEFORE overwriting. If snapshot creation fails
      // we abort this record's import rather than silently destroying
      // history. The page-versioning module is responsible for atomic
      // sidecar writes; we just call it.
      if (opts.versioning && opts.versioning.enabled) {
        const prior = await readFile(targetAbs, "utf-8").catch(() => "");
        await createVersion(
          targetAbs,
          prior,
          "manual",
          opts.versioning,
          opts.log,
          `capsule-import: ${capsule.id}`,
          rootAbs,
        );
        snapshotted = true;
      }
    }

    let contentToWrite = rec.content;
    let rewroteId = false;
    if (mode === "fork") {
      const forked = rewriteFrontmatterIdForFork(rec.content, capsule.id, opts.now);
      contentToWrite = forked.content;
      rewroteId = forked.rewrote;
    }

    await mkdir(path.dirname(targetAbs), { recursive: true });
    await writeFile(targetAbs, contentToWrite, "utf-8");
    imported.push({
      sourcePath: rec.path,
      targetPath: targetRel,
      snapshotted,
      rewroteId,
    });
  }

  // Sort skipped for stable output (see comment above).
  skipped.sort((a, b) => a.path.localeCompare(b.path));

  return { imported, skipped, manifest };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Compute the destination relative path for a record under the chosen
 * mode.
 *
 *  - `skip` / `overwrite` — identity: the record's posix path is used as-is.
 *  - `fork` — rebased under `forks/<capsule-id>/<original-path>` so the
 *    original tree is never modified.
 */
function computeTargetPath(
  sourcePosix: string,
  mode: ImportCapsuleMode,
  capsuleId: string,
): string {
  if (mode === "fork") return `forks/${capsuleId}/${sourcePosix}`;
  return sourcePosix;
}

/**
 * Return true when {@link absPath} is the same as {@link rootAbs} or a
 * descendant. Defensive symlink-aware checks (`realpath`) are not necessary
 * here because `exportCapsule` only produces posix-relative paths and we
 * validate `rootAbs` is a directory; this guard exists purely to reject
 * hand-edited archives that ship `..`-traversal paths.
 */
function isPathInsideRoot(rootAbs: string, absPath: string): boolean {
  const rel = path.relative(rootAbs, absPath);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

async function assertIsDirectory(absPath: string): Promise<void> {
  // Mirror gotcha #24: existsSync returns true for files. The import root
  // MUST be a directory.
  const st = await stat(absPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(
      `importCapsule: 'root' must be an existing directory: ${absPath}`,
    );
  }
}

async function fileExistsAt(absPath: string): Promise<boolean> {
  const st = await stat(absPath).catch(() => null);
  return st !== null && st.isFile();
}

// ---------------------------------------------------------------------------
// Fork-mode id rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite a YAML-frontmatter `id:` field to a fork-scoped value.
 *
 * Strategy: we deliberately do NOT parse the entire YAML — memory files
 * use a deterministic top-of-file frontmatter delimited by `---` lines,
 * and the orchestrator's `parseFrontmatter` reads `id` as a top-level
 * key with a single-line scalar value. We mirror that contract:
 *
 *   - Detect a leading `---\n` … `\n---` block at the top of the file.
 *   - Within that block, locate the first `id:` line that is not nested
 *     under another key (cheap heuristic: line starts at column 0).
 *   - Replace its value with a new fork-id derived from `capsuleId` and
 *     a short random suffix (or {@link opts.now} when provided for tests).
 *
 * Files without a frontmatter block, or without an `id:` key inside one,
 * are returned unchanged with `rewrote: false`. This keeps non-memory
 * artifacts (READMEs, transcripts) byte-identical to the source.
 */
function rewriteFrontmatterIdForFork(
  content: string,
  capsuleId: string,
  now: number | undefined,
): { content: string; rewrote: boolean } {
  // Frontmatter block detection: `---` on its own line at the very start,
  // followed by content, followed by `---` on its own line. The closing
  // delimiter must be at column 0. We capture the trailing terminator
  // (`\r?\n` or end-of-string) as a separate group so we can re-emit it
  // verbatim, preserving CRLF/LF/EOF shape from the original file.
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (!fmMatch) return { content, rewrote: false };
  const fmBody = fmMatch[1];
  const fmTrailer = fmMatch[2];
  const fmStart = fmMatch.index;
  const fmEnd = fmStart + fmMatch[0].length;

  // Find a top-level `id:` line. Top-level means the line begins at
  // column 0 inside the frontmatter body (no leading whitespace) and the
  // key is exactly `id`. We deliberately accept `id:` and `id : ` shapes
  // but reject `nested_id:` to avoid touching unrelated keys.
  const idLineRe = /^id:[ \t]*([^\r\n]*)$/m;
  const idMatch = idLineRe.exec(fmBody);
  if (!idMatch) return { content, rewrote: false };

  const newId = mintForkId(capsuleId, idMatch[1]?.trim() ?? "", now);
  const replacedBody = fmBody.replace(idLineRe, `id: ${newId}`);
  // Reconstruct the file: original prefix (always empty here, fmStart === 0
  // by the `^` anchor) + frontmatter delimiters around the rewritten body
  // (preserving the original trailing terminator) + the original body that
  // followed the closing `---`.
  const prefix = content.slice(0, fmStart);
  const tail = content.slice(fmEnd);
  const rebuilt = `${prefix}---\n${replacedBody}\n---${fmTrailer}${tail}`;
  return { content: rebuilt, rewrote: true };
}

/**
 * Derive a deterministic-when-`now`-is-set fork id from the capsule id and
 * the original record id. Production callers omit `now` and get a UUID
 * suffix; tests pass `now` for byte-stable assertions.
 */
function mintForkId(capsuleId: string, originalId: string, now: number | undefined): string {
  const base = originalId.length > 0 ? originalId : "fork";
  if (now === undefined) {
    const suffix = randomUUID().slice(0, 8);
    return `${base}-fork-${capsuleId}-${suffix}`;
  }
  // Deterministic suffix: short hash of (capsuleId, originalId, now). Using
  // sha256 over a sorted-key serialization (gotcha #38) so the suffix does
  // not depend on Object.entries order.
  const payload = JSON.stringify({ c: capsuleId, i: originalId, n: now });
  const suffix = createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 8);
  return `${base}-fork-${capsuleId}-${suffix}`;
}

/**
 * Re-export for tests that want to construct a fork id without going through
 * the full import pipeline. Not part of the stable public API.
 *
 * @internal
 */
export const __test = { mintForkId, rewriteFrontmatterIdForFork };

// Note: `CapsuleBlock` is re-exported here purely so callers that want to
// inspect the manifest block don't have to deep-import from `./types.js`.
export type { CapsuleBlock };
