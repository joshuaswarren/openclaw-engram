/**
 * Common interface for memory systems under evaluation.
 * Both the direct-import adapter and MCP HTTP adapter implement this.
 */

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SearchResult {
  turnIndex: number;
  role: string;
  snippet: string;
  sessionId: string;
  score?: number;
}

export interface MemoryStats {
  totalMessages: number;
  totalSummaryNodes: number;
  maxDepth: number;
}

export interface MemorySystem {
  /** Feed conversation turns into memory. */
  store(sessionId: string, messages: Message[]): Promise<void>;

  /** Retrieve compressed context for a query. */
  recall(sessionId: string, query: string, budgetChars?: number): Promise<string>;

  /** Full-text search across stored messages. */
  search(query: string, limit: number, sessionId?: string): Promise<SearchResult[]>;

  /** Clear state for a session (or all sessions). */
  reset(sessionId?: string): Promise<void>;

  /** Get statistics about stored memory. */
  getStats(sessionId?: string): Promise<MemoryStats>;

  /** Tear down resources (close DB, etc). */
  destroy(): Promise<void>;
}

export interface BenchmarkTask {
  id: string;
  description: string;
  input: unknown;
  expectedOutput?: unknown;
}

export interface TaskScore {
  taskId: string;
  metrics: Record<string, number>;
  details?: Record<string, unknown>;
  latencyMs: number;
}

export interface BenchmarkMeta {
  name: string;
  version: string;
  description: string;
  category: "agentic" | "retrieval" | "conversational";
  citation?: string;
}

export interface BenchmarkResult {
  meta: BenchmarkMeta;
  engramVersion: string;
  gitSha: string;
  timestamp: string;
  adapterMode: "direct" | "mcp";
  taskCount: number;
  scores: TaskScore[];
  aggregate: Record<string, number>;
  config: Record<string, unknown>;
  durationMs: number;
}

export interface BenchmarkRunner {
  meta: BenchmarkMeta;
  run(
    system: MemorySystem,
    options: { limit?: number; datasetDir: string },
  ): Promise<BenchmarkResult>;
}
