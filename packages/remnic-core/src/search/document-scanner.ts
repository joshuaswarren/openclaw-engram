import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

export interface IndexableDocument {
  /** Memory ID from frontmatter or filename stem */
  docid: string;
  /** Absolute file path */
  path: string;
  /** Markdown body (no YAML frontmatter) */
  content: string;
  /** First ~200 chars for display */
  snippet: string;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the frontmatter key-value pairs and body, or null if no frontmatter block.
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } | null {
  // Support both LF and CRLF line endings
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const body = (match[2] ?? "").trim();
  const data: Record<string, string> = {};

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    data[key] = value;
  }

  return { data, body };
}

/**
 * Recursively scan a directory for `.md` files and return IndexableDocuments.
 */
async function scanDir(dir: string): Promise<IndexableDocument[]> {
  const docs: IndexableDocument[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await scanDir(fullPath);
        docs.push(...sub);
      } else if (entry.name.endsWith(".md")) {
        try {
          const raw = await readFile(fullPath, "utf-8");
          const parsed = parseFrontmatter(raw);
          const body = parsed ? parsed.body : raw.trim();
          const docid = parsed?.data.id || path.basename(entry.name, ".md");
          docs.push({
            docid,
            path: fullPath,
            content: body,
            snippet: body.slice(0, 200),
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // Directory doesn't exist yet — not an error
  }
  return docs;
}

/**
 * Scan `facts/`, `corrections/`, `procedures/`, and `reasoning-traces/`
 * subdirs of memoryDir for indexable markdown documents.
 *
 * Note: reasoning-traces live under their own subtree (issue #564 PR 3).
 * Non-QMD backends (Orama / Meilisearch / LanceDB) build their index
 * through this helper, so any new category subtree must be listed here
 * or those backends silently stop seeing the new memories.
 */
export async function scanMemoryDir(memoryDir: string): Promise<IndexableDocument[]> {
  const factsDir = path.join(memoryDir, "facts");
  const correctionsDir = path.join(memoryDir, "corrections");
  const proceduresDir = path.join(memoryDir, "procedures");
  const reasoningTracesDir = path.join(memoryDir, "reasoning-traces");
  const [facts, corrections, procedures, reasoningTraces] = await Promise.all([
    scanDir(factsDir),
    scanDir(correctionsDir),
    scanDir(proceduresDir),
    scanDir(reasoningTracesDir),
  ]);
  return [...facts, ...corrections, ...procedures, ...reasoningTraces];
}
