/**
 * Public artifacts provider for memory-wiki bridge mode.
 *
 * Enumerates Remnic artifacts that are safe for wiki ingestion:
 *   - facts/   (extracted knowledge)
 *   - entities/ (entity knowledge graph)
 *   - corrections/ (fact corrections)
 *   - artifacts/ (structured artifacts)
 *   - profile.md (agent personality/identity — public summary only)
 *
 * Private/runtime state (state/, questions/, transcripts, buffers, etc.)
 * is explicitly excluded.
 */

import { readdir, access, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Content type for a public artifact.
 * Mirrors MemoryPluginPublicArtifactContentType from OpenClaw SDK.
 */
export type PublicArtifactContentType = "markdown" | "json" | "text";

/**
 * A single public artifact entry.
 * Mirrors MemoryPluginPublicArtifact from OpenClaw SDK.
 */
export interface RemnicPublicArtifact {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: PublicArtifactContentType;
}

/**
 * Directories and file patterns that are safe to expose as public artifacts.
 * Each entry maps a directory name (relative to memoryDir) to the artifact
 * kind and content type.
 */
const PUBLIC_DIRS: ReadonlyArray<{
  dir: string;
  kind: string;
  contentType: PublicArtifactContentType;
  recursive: boolean;
}> = [
  { dir: "facts", kind: "fact", contentType: "markdown", recursive: true },
  { dir: "entities", kind: "entity", contentType: "markdown", recursive: true },
  { dir: "corrections", kind: "correction", contentType: "markdown", recursive: true },
  { dir: "artifacts", kind: "artifact", contentType: "markdown", recursive: true },
];

/**
 * Standalone files (relative to memoryDir) that are safe to expose.
 */
const PUBLIC_FILES: ReadonlyArray<{
  relativePath: string;
  kind: string;
  contentType: PublicArtifactContentType;
}> = [
  { relativePath: "profile.md", kind: "memory-root", contentType: "markdown" },
];

/**
 * Recursively list all markdown files under a directory.
 */
async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFilesRecursive(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Check if a file or directory exists.
 */
async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await access(inputPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all public artifacts from a Remnic memory directory.
 *
 * This is the core implementation that enumerates safe/public memory files
 * for wiki ingestion. It intentionally excludes:
 *   - state/        (runtime indexes, caches, internal state)
 *   - questions/    (pending review queue — private)
 *   - transcripts/  (raw conversation logs — private)
 *   - archive/      (archived/demoted memories — stale)
 *   - buffers       (in-flight extraction state)
 *   - tokens/       (auth credentials)
 *
 * @param memoryDir - Absolute path to the Remnic memory directory
 * @param workspaceDir - The workspace directory for this agent
 * @param agentIds - Agent IDs that own this memory
 */
export async function listRemnicPublicArtifacts(params: {
  memoryDir: string;
  workspaceDir: string;
  agentIds: string[];
}): Promise<RemnicPublicArtifact[]> {
  const { memoryDir, workspaceDir, agentIds } = params;
  const artifacts: RemnicPublicArtifact[] = [];

  // Scan public directories
  for (const spec of PUBLIC_DIRS) {
    const dirPath = path.join(memoryDir, spec.dir);
    if (!(await pathExists(dirPath))) continue;

    const files = spec.recursive
      ? await listMarkdownFilesRecursive(dirPath)
      : [];

    if (!spec.recursive) {
      // Non-recursive: only list direct children
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            files.push(path.join(dirPath, entry.name));
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    for (const absolutePath of files) {
      const relativePath = path.relative(memoryDir, absolutePath).replace(/\\/g, "/");
      artifacts.push({
        kind: spec.kind,
        workspaceDir,
        relativePath,
        absolutePath,
        agentIds: [...agentIds],
        contentType: spec.contentType,
      });
    }
  }

  // Scan standalone public files
  for (const spec of PUBLIC_FILES) {
    const absolutePath = path.join(memoryDir, spec.relativePath);
    if (!(await pathExists(absolutePath))) continue;
    // Verify it's a file (not a directory)
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) continue;
    } catch {
      continue;
    }
    artifacts.push({
      kind: spec.kind,
      workspaceDir,
      relativePath: spec.relativePath,
      absolutePath,
      agentIds: [...agentIds],
      contentType: spec.contentType,
    });
  }

  // Deduplicate by (workspaceDir, relativePath, kind) — defensive against
  // overlapping scans or symlinks.
  const deduped = new Map<string, RemnicPublicArtifact>();
  for (const artifact of artifacts) {
    const key = `${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`;
    deduped.set(key, artifact);
  }

  return [...deduped.values()];
}
