import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConversationChunk } from "./chunker.js";

export function sanitizeSessionKey(sessionKey: string): string {
  const raw = typeof sessionKey === "string" && sessionKey.trim().length > 0
    ? sessionKey
    : "unknown-session";
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 200);
}

export async function writeConversationChunks(
  rootDir: string,
  chunks: ConversationChunk[],
): Promise<string[]> {
  const written: string[] = [];
  for (const c of chunks) {
    const safe = sanitizeSessionKey(c.sessionKey);
    const date = c.startTs.slice(0, 10);
    const dir = path.join(rootDir, safe, date);
    await mkdir(dir, { recursive: true });
    const fp = path.join(dir, `${c.id}.md`);
    const content =
      `---\n` +
      `kind: conversation_chunk\n` +
      `sessionKey: ${c.sessionKey}\n` +
      `startTs: ${c.startTs}\n` +
      `endTs: ${c.endTs}\n` +
      `---\n\n` +
      c.text +
      "\n";
    await writeFile(fp, content, "utf-8");
    written.push(fp);
  }
  return written;
}
