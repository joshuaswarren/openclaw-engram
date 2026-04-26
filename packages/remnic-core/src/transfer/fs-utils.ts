import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const buf = await readFile(filePath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { sha256, bytes: buf.byteLength };
}

export function sha256String(content: string): { sha256: string; bytes: number } {
  const buf = Buffer.from(content, "utf-8");
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { sha256, bytes: buf.byteLength };
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(fp);
      } else if (ent.isFile()) {
        out.push(fp);
      }
    }
  }
  await walk(rootDir);
  return out.sort();
}

export async function ensureDirExists(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function toPosixRelPath(absPath: string, rootDir: string): string {
  const rel = path.relative(rootDir, absPath);
  // normalize to posix for portability across platforms
  return rel.split(path.sep).join("/");
}

export function fromPosixRelPath(relPath: string): string {
  return relPath.split("/").join(path.sep);
}

/**
 * Assert that {@link absPath} is an existing directory that is NOT itself a
 * symlink.
 *
 * Using `stat` alone is insufficient: it follows symlinks, so a symlink
 * pointing at `/etc` (or any other sensitive directory) would pass the
 * `isDirectory()` check and silently allow writes to the resolved target.
 * We first run `stat` to confirm the path is a directory (following the
 * link if present) and then `lstat` to confirm the path itself is not a
 * symbolic link.
 *
 * Mirrors the pattern used in `capsule-import.ts`'s local `assertIsDirectory`
 * (Codex P1 #741 round 5) and extracted here so both capsule-import and
 * capsule-fork share the same hardened helper (Cursor medium #751 round 2).
 *
 * @param absPath      Absolute path to verify.
 * @param callerPrefix Short module name for the error message, e.g.
 *                     `"forkCapsule"`. Defaults to `"assertIsDirectoryNotSymlink"`.
 */
export async function assertIsDirectoryNotSymlink(
  absPath: string,
  callerPrefix = "assertIsDirectoryNotSymlink",
): Promise<void> {
  const st = await stat(absPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(`${callerPrefix}: path must be an existing directory: ${absPath}`);
  }
  const lst = await lstat(absPath).catch(() => null);
  if (lst && lst.isSymbolicLink()) {
    throw new Error(
      `${callerPrefix}: path must not be a symlink — resolve it to its real path first: ${absPath}`,
    );
  }
}
