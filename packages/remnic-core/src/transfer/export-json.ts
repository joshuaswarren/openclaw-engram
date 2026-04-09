import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION } from "./constants.js";
import { listFilesRecursive, sha256File, sha256String, toPosixRelPath, writeJsonFile } from "./fs-utils.js";
import type { ExportBundleV1, ExportManifestV1, ExportMemoryRecordV1 } from "./types.js";

export interface ExportCommonOptions {
  memoryDir: string;
  outDir: string;
  includeTranscripts?: boolean;
  includeWorkspaceIdentity?: boolean;
  workspaceDir?: string;
  pluginVersion: string;
}

const DEFAULT_EXCLUDES = new Set([
  "node_modules",
  ".git",
]);

function shouldExclude(relPosix: string, includeTranscripts: boolean): boolean {
  const parts = relPosix.split("/");
  if (parts.some((p) => DEFAULT_EXCLUDES.has(p))) return true;
  if (!includeTranscripts && parts[0] === "transcripts") return true;
  return false;
}

export async function exportJsonBundle(opts: ExportCommonOptions): Promise<void> {
  const includeTranscripts = opts.includeTranscripts === true;
  const outDirAbs = path.resolve(opts.outDir);
  await mkdir(outDirAbs, { recursive: true });

  const memoryDirAbs = path.resolve(opts.memoryDir);
  const filesAbs = await listFilesRecursive(memoryDirAbs);

  const records: ExportMemoryRecordV1[] = [];
  const manifestFiles: ExportManifestV1["files"] = [];

  for (const abs of filesAbs) {
    const relPosix = toPosixRelPath(abs, memoryDirAbs);
    if (shouldExclude(relPosix, includeTranscripts)) continue;

    const content = await readFile(abs, "utf-8");
    records.push({ path: relPosix, content });
    const { sha256, bytes } = await sha256File(abs);
    manifestFiles.push({ path: relPosix, sha256, bytes });
  }

  // Optionally include workspace identity file (outside memoryDir).
  if (opts.includeWorkspaceIdentity !== false && opts.workspaceDir) {
    const identityPath = path.join(opts.workspaceDir, "IDENTITY.md");
    try {
      const content = await readFile(identityPath, "utf-8");
      const relPath = "workspace/IDENTITY.md";
      records.push({ path: relPath, content });
      const { sha256, bytes } = sha256String(content);
      manifestFiles.push({ path: relPath, sha256, bytes });
    } catch {
      // identity optional
    }
  }

  const manifest: ExportManifestV1 = {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    pluginVersion: opts.pluginVersion,
    includesTranscripts: includeTranscripts,
    files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
  };

  const bundle: ExportBundleV1 = { manifest, records };

  await writeJsonFile(path.join(outDirAbs, "manifest.json"), manifest);
  await writeJsonFile(path.join(outDirAbs, "bundle.json"), bundle);
}
