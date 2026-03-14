import type Database from "better-sqlite3";
import { openLcmDatabase, ensureLcmStateDir } from "./schema.js";
import { LcmArchive, estimateTokens } from "./archive.js";
import { LcmDag } from "./dag.js";
import { LcmSummarizer, type LcmSummarizerConfig, type SummarizeFn } from "./summarizer.js";
import { assembleCompressedHistory, type LcmRecallConfig } from "./recall.js";
import type { PluginConfig } from "../types.js";
import { log } from "../logger.js";

export interface LcmEngineConfig {
  enabled: boolean;
  leafBatchSize: number;
  rollupFanIn: number;
  freshTailTurns: number;
  maxDepth: number;
  deterministicMaxTokens: number;
  archiveRetentionDays: number;
  recallBudgetShare: number;
}

export function extractLcmConfig(cfg: PluginConfig): LcmEngineConfig {
  return {
    enabled: (cfg as any).lcmEnabled === true,
    leafBatchSize: (cfg as any).lcmLeafBatchSize ?? 8,
    rollupFanIn: (cfg as any).lcmRollupFanIn ?? 4,
    freshTailTurns: (cfg as any).lcmFreshTailTurns ?? 16,
    maxDepth: (cfg as any).lcmMaxDepth ?? 5,
    deterministicMaxTokens: (cfg as any).lcmDeterministicMaxTokens ?? 512,
    archiveRetentionDays: (cfg as any).lcmArchiveRetentionDays ?? 90,
    recallBudgetShare: (cfg as any).lcmRecallBudgetShare ?? 0.15,
  };
}

export class LcmEngine {
  private db: Database.Database | null = null;
  private archive: LcmArchive | null = null;
  private dag: LcmDag | null = null;
  private summarizer: LcmSummarizer | null = null;
  private readonly config: LcmEngineConfig;
  private readonly memoryDir: string;
  private initPromise: Promise<void> | null = null;

  constructor(
    pluginConfig: PluginConfig,
    private readonly summarizeFn: SummarizeFn,
  ) {
    this.config = extractLcmConfig(pluginConfig);
    this.memoryDir = pluginConfig.memoryDir;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Lazy init — open database on first use. */
  async ensureInitialized(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.doInit();
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    await ensureLcmStateDir(this.memoryDir);
    this.db = openLcmDatabase(this.memoryDir);
    this.archive = new LcmArchive(this.db);
    this.dag = new LcmDag(this.db);
    this.summarizer = new LcmSummarizer(this.archive, this.dag, this.summarizeFn, {
      leafBatchSize: this.config.leafBatchSize,
      rollupFanIn: this.config.rollupFanIn,
      maxDepth: this.config.maxDepth,
      deterministicMaxTokens: this.config.deterministicMaxTokens,
    });
    log.info("LCM engine initialized");
  }

  /**
   * Observe messages from agent_end hook.
   * Indexes new messages and triggers incremental summarization.
   */
  async observeMessages(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    if (!this.config.enabled) return;
    await this.ensureInitialized();

    const currentMax = this.archive!.getMaxTurnIndex(sessionId);
    const newMessages = messages.map((m, i) => ({
      turnIndex: currentMax + 1 + i,
      role: m.role,
      content: m.content,
    }));

    if (newMessages.length === 0) return;

    this.archive!.appendMessages(sessionId, newMessages);

    // Trigger incremental summarization (best effort)
    try {
      await this.summarizer!.summarizeIncremental(sessionId);
    } catch (err) {
      log.debug(`LCM incremental summarization error: ${err}`);
    }
  }

  /** Build the compressed history recall section for a session. */
  async assembleRecall(sessionId: string, budgetChars: number): Promise<string> {
    if (!this.config.enabled) return "";
    await this.ensureInitialized();

    const effectiveBudget = Math.ceil(budgetChars * this.config.recallBudgetShare);
    if (effectiveBudget <= 0) return "";

    return assembleCompressedHistory(this.dag!, this.archive!, sessionId, {
      freshTailTurns: this.config.freshTailTurns,
      budgetChars: effectiveBudget,
    });
  }

  /** Record a compaction event (called from before_compaction hook). */
  async recordCompaction(
    sessionId: string,
    tokensBefore: number,
    tokensAfter: number,
  ): Promise<void> {
    if (!this.config.enabled) return;
    await this.ensureInitialized();

    const maxTurn = this.archive!.getMaxTurnIndex(sessionId);

    // Flush pending summarization before compaction
    try {
      await this.summarizer!.summarizeIncremental(sessionId);
    } catch (err) {
      log.debug(`LCM pre-compaction flush error: ${err}`);
    }

    this.dag!.recordCompaction(sessionId, maxTurn, tokensBefore, tokensAfter);
    log.info(
      `LCM compaction recorded: session=${sessionId}, turn=${maxTurn}, tokens ${tokensBefore}→${tokensAfter}`,
    );
  }

  /** Verify archive coverage after compaction. */
  async verifyPostCompaction(sessionId: string): Promise<void> {
    if (!this.config.enabled) return;
    await this.ensureInitialized();

    const msgCount = this.archive!.getMessageCount(sessionId);
    const nodeCount = this.dag!.getNodeCount(sessionId);
    log.debug(
      `LCM post-compaction verify: session=${sessionId}, messages=${msgCount}, summaryNodes=${nodeCount}`,
    );
  }

  // ── MCP Tool implementations ──

  /** Search across all conversation history via FTS. */
  async searchContext(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<Array<{ turn_index: number; role: string; snippet: string; session_id: string }>> {
    if (!this.config.enabled) return [];
    await this.ensureInitialized();
    return this.archive!.search(query, limit, sessionId);
  }

  /** Get a compressed summary of a turn range. */
  async describeContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
  ): Promise<{ summary: string; turn_count: number; depth: number } | null> {
    if (!this.config.enabled) return null;
    await this.ensureInitialized();

    const nodes = this.dag!.getCoveringNodes(sessionId, fromTurn, toTurn);
    if (nodes.length === 0) {
      // No summary exists — build a description from raw messages
      const messages = this.archive!.getMessages(sessionId, fromTurn, toTurn);
      if (messages.length === 0) return null;
      const preview = messages
        .slice(0, 5)
        .map((m) => `[${m.role}] ${m.content.slice(0, 100)}`)
        .join("\n");
      return {
        summary: `No summary available for this range. Preview of ${messages.length} messages:\n${preview}`,
        turn_count: messages.length,
        depth: -1,
      };
    }

    // Use the deepest covering node
    const best = nodes[0]; // Already sorted by depth DESC
    return {
      summary: best.summary_text,
      turn_count: best.msg_end - best.msg_start + 1,
      depth: best.depth,
    };
  }

  /** Retrieve raw messages for a turn range (lossless expansion). */
  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>> {
    if (!this.config.enabled) return [];
    await this.ensureInitialized();

    const messages = this.archive!.getMessages(sessionId, fromTurn, toTurn);
    if (messages.length === 0) return [];

    // Enforce token budget — keep first and last, truncate middle
    const maxChars = maxTokens * 4;
    let totalChars = 0;
    for (const m of messages) totalChars += m.content.length;

    if (totalChars <= maxChars) {
      return messages.map((m) => ({
        turn_index: m.turn_index,
        role: m.role,
        content: m.content,
      }));
    }

    // Keep first and last messages, truncate from middle
    const result: Array<{ turn_index: number; role: string; content: string }> = [];
    let budget = maxChars;

    // Reserve space for the last message
    const lastMsg = messages[messages.length - 1];
    const lastMsgChars = Math.min(lastMsg.content.length, Math.floor(maxChars * 0.3));
    budget -= lastMsgChars;

    // Add messages from the beginning
    for (let i = 0; i < messages.length - 1; i++) {
      if (budget <= 0) break;
      const m = messages[i];
      const truncated = m.content.slice(0, budget);
      result.push({ turn_index: m.turn_index, role: m.role, content: truncated });
      budget -= truncated.length;
    }

    // Always append the last message
    result.push({
      turn_index: lastMsg.turn_index,
      role: lastMsg.role,
      content: lastMsg.content.slice(0, lastMsgChars + Math.max(0, budget)),
    });

    return result;
  }

  /** Get statistics about the LCM archive. */
  async getStats(sessionId?: string): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
  }> {
    if (!this.config.enabled) return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: -1 };
    await this.ensureInitialized();

    if (sessionId) {
      return {
        totalMessages: this.archive!.getMessageCount(sessionId),
        totalSummaryNodes: this.dag!.getNodeCount(sessionId),
        maxDepth: this.dag!.getMaxDepth(sessionId),
      };
    }

    return {
      totalMessages: this.archive!.getTotalMessageCount(),
      totalSummaryNodes: 0, // Would need a global count query
      maxDepth: -1,
    };
  }

  /** Prune old data beyond retention period. */
  async prune(): Promise<{ messagesPruned: number; nodesPruned: number }> {
    if (!this.config.enabled) return { messagesPruned: 0, nodesPruned: 0 };
    await this.ensureInitialized();

    const messagesPruned = this.archive!.pruneOldMessages(this.config.archiveRetentionDays);
    const nodesPruned = this.dag!.pruneOldNodes(this.config.archiveRetentionDays);
    return { messagesPruned, nodesPruned };
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.archive = null;
      this.dag = null;
      this.summarizer = null;
    }
  }
}
