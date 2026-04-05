import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";
import type { FaissConversationIndexAdapter } from "./faiss-adapter.js";
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

export interface ConversationChunkUpsertResult {
  upserted: number;
  skipped: boolean;
  reason?: "adapter-unavailable" | "adapter-error";
}

export interface ConversationChunkRebuildResult {
  rebuilt: number;
  skipped: boolean;
  reason?: "adapter-unavailable" | "adapter-error";
}

export async function upsertConversationChunksFailOpen(
  adapter: FaissConversationIndexAdapter | undefined,
  chunks: ConversationChunk[],
): Promise<ConversationChunkUpsertResult> {
  if (!adapter) {
    return { upserted: 0, skipped: true, reason: "adapter-unavailable" };
  }
  try {
    const upserted = await adapter.upsertChunks(chunks);
    return { upserted, skipped: false };
  } catch (err) {
    log.debug(`conversation index FAISS upsert failed (fail-open): ${err}`);
    return { upserted: 0, skipped: true, reason: "adapter-error" };
  }
}

export async function rebuildConversationChunksFailOpen(
  adapter: FaissConversationIndexAdapter | undefined,
  chunks: ConversationChunk[],
): Promise<ConversationChunkRebuildResult> {
  if (!adapter) {
    return { rebuilt: 0, skipped: true, reason: "adapter-unavailable" };
  }
  try {
    const rebuilt = await adapter.rebuildChunks(chunks);
    return { rebuilt, skipped: false };
  } catch (err) {
    log.debug(`conversation index FAISS rebuild failed (fail-open): ${err}`);
    return { rebuilt: 0, skipped: true, reason: "adapter-error" };
  }
}
