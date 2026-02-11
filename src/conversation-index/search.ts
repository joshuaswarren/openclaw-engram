import { log } from "../logger.js";
import type { QmdClient } from "../qmd.js";

export interface ConversationSearchResult {
  path: string;
  snippet: string;
  score: number;
}

export async function searchConversationIndex(
  qmd: QmdClient,
  query: string,
  maxResults: number,
): Promise<ConversationSearchResult[]> {
  try {
    const results = await qmd.search(query, undefined, maxResults);
    return results.map((r) => ({ path: r.path, snippet: r.snippet, score: r.score }));
  } catch (err) {
    log.debug(`conversation index search failed: ${err}`);
    return [];
  }
}

