import { log } from "./logger.js";
import path from "node:path";
import { SmartBuffer } from "./buffer.js";
import { chunkContent, type ChunkingConfig } from "./chunking.js";
import { ExtractionEngine } from "./extraction.js";
import { scoreImportance } from "./importance.js";
import { QmdClient } from "./qmd.js";
import { StorageManager } from "./storage.js";
import { ThreadingManager } from "./threading.js";
import { extractTopics } from "./topics.js";
import { TranscriptManager } from "./transcript.js";
import { HourlySummarizer } from "./summarizer.js";
import { LocalLlmClient } from "./local-llm.js";
import { ModelRegistry } from "./model-registry.js";
import type { MemorySummary } from "./types.js";
import type {
  AccessTrackingEntry,
  BufferTurn,
  ExtractionResult,
  MemoryLink,
  PluginConfig,
  QmdSearchResult,
} from "./types.js";

export class Orchestrator {
  readonly storage: StorageManager;
  readonly qmd: QmdClient;
  readonly buffer: SmartBuffer;
  readonly transcript: TranscriptManager;
  readonly summarizer: HourlySummarizer;
  readonly localLlm: LocalLlmClient;
  readonly modelRegistry: ModelRegistry;
  private readonly extraction: ExtractionEngine;
  readonly config: PluginConfig;
  private readonly threading: ThreadingManager;

  // Access tracking buffer (Phase 1A)
  // Maps memoryId -> {count, lastAccessed} for batched updates
  private accessTrackingBuffer: Map<string, { count: number; lastAccessed: string }> =
    new Map();

  // Background serial queue for extractions (agent_end optimization)
  // Queue stores promises that resolve when extraction should run
  private extractionQueue: Array<() => Promise<void>> = [];
  private queueProcessing = false;

  constructor(config: PluginConfig) {
    this.config = config;
    this.storage = new StorageManager(config.memoryDir);
    this.qmd = new QmdClient(config.qmdCollection, config.qmdMaxResults, {
      enabled: config.slowLogEnabled,
      thresholdMs: config.slowLogThresholdMs,
    });
    this.buffer = new SmartBuffer(config, this.storage);
    this.transcript = new TranscriptManager(config);
    this.modelRegistry = new ModelRegistry(config.memoryDir);
    this.summarizer = new HourlySummarizer(config, config.gatewayConfig, this.modelRegistry);
    this.localLlm = new LocalLlmClient(config, this.modelRegistry);
    this.extraction = new ExtractionEngine(config, this.localLlm, config.gatewayConfig, this.modelRegistry);
    this.threading = new ThreadingManager(
      path.join(config.memoryDir, "threads"),
      config.threadingGapMinutes,
    );
  }

  async initialize(): Promise<void> {
    await this.storage.ensureDirectories();
    await this.storage.loadAliases();
    await this.transcript.initialize();
    await this.summarizer.initialize();

    if (this.config.qmdEnabled) {
      const available = await this.qmd.probe();
      if (available) {
        log.info("QMD: available");
        await this.qmd.ensureCollection(this.config.memoryDir);
      } else {
        log.warn("QMD: not available (qmd command not found)");
      }
    }

    await this.buffer.load();

    // Validate local LLM model configuration
    if (this.config.localLlmEnabled) {
      await this.validateLocalLlmModel();
    }

    log.info("orchestrator initialized");
  }

  /**
   * Validate local LLM model availability and context window compatibility.
   * Warns the user if there's a mismatch.
   */
  private async validateLocalLlmModel(): Promise<void> {
    log.info("Local LLM: Validating model configuration...");
    try {
      const modelInfo = await this.localLlm.getLoadedModelInfo();
      if (!modelInfo) {
        log.warn("Local LLM validation: Could not query model info from server");
        log.warn(
          "Local LLM validation: Could not query model info. " +
          "Ensure LM Studio/Ollama is running with the model loaded."
        );
        return;
      }

      // Check for context window mismatch
      const configuredMaxContext = this.config.localLlmMaxContext;

      if (modelInfo.contextWindow) {
        log.info(
          `Local LLM: ${modelInfo.id} loaded with ${modelInfo.contextWindow.toLocaleString()} token context window`
        );

        if (configuredMaxContext && configuredMaxContext > modelInfo.contextWindow) {
          log.warn(
            `Local LLM context mismatch: engram configured for ${configuredMaxContext.toLocaleString()} tokens, ` +
            `but ${modelInfo.id} only supports ${modelInfo.contextWindow.toLocaleString()}. ` +
            `Reducing to ${modelInfo.contextWindow.toLocaleString()} to avoid errors.`
          );
          // Update the config in-memory to match actual capability
          // (This is a temporary fix - user should update their config)
          (this.config as { localLlmMaxContext?: number }).localLlmMaxContext = modelInfo.contextWindow;
        }
      } else {
        log.info(`Local LLM: ${modelInfo.id} loaded (context window not reported by server)`);

        if (!configuredMaxContext) {
          log.warn(
            "Local LLM: Server did not report context window. " +
            "If you get 'context length exceeded' errors, set localLlmMaxContext in your config. " +
            "Common defaults: LM Studio (32K), Ollama (2K-128K depending on model)."
          );
        }
      }
    } catch (err) {
      log.warn(`Local LLM validation failed: ${err}`);
    }
  }

  async recall(prompt: string, sessionKey?: string): Promise<string> {
    // Wrap recall logic with a 30-second timeout to prevent agent hangs
    const RECALL_TIMEOUT_MS = 30000;
    return Promise.race([
      this.recallInternal(prompt, sessionKey),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("recall timeout")), RECALL_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      log.warn(`recall timed out or failed: ${err}`);
      return ""; // Return empty context on timeout/error
    });
  }

  private async recallInternal(prompt: string, sessionKey?: string): Promise<string> {
    const sections: string[] = [];

    // 1. Profile (existing)
    const profile = await this.storage.readProfile();
    if (profile) {
      sections.push(`## User Profile\n\n${profile}`);
    }

    // 2. Memories via QMD (existing)
    if (this.config.qmdEnabled && this.qmd.isAvailable()) {
      const [memoryResultsRaw, globalResults] = await Promise.all([
        this.qmd.search(prompt),
        // Search global collections for workspace context
        this.qmd.searchGlobal(prompt, 6),
      ]);

      let memoryResults = memoryResultsRaw;

      // Apply recency and access count boosting
      memoryResults = await this.boostSearchResults(memoryResults);

      if (memoryResults.length > 0) {
        // Track access for these memories
        const memoryIds = this.extractMemoryIdsFromResults(memoryResults);
        this.trackMemoryAccess(memoryIds);

        sections.push(this.formatQmdResults("Relevant Memories", memoryResults));
      }

      if (globalResults.length > 0) {
        sections.push(
          this.formatQmdResults("Workspace Context", globalResults),
        );
      }
    } else {
      // Fallback: read recent memories directly
      const memories = await this.storage.readAllMemories();
      if (memories.length > 0) {
        // Filter out non-active memories
        const activeMemories = memories.filter(
          (m) => !m.frontmatter.status || m.frontmatter.status === "active",
        );
        const recent = activeMemories
          .sort(
            (a, b) =>
              new Date(b.frontmatter.updated).getTime() -
              new Date(a.frontmatter.updated).getTime(),
          )
          .slice(0, 10);

        // Track access for these memories
        const memoryIds = recent.map((m) => m.frontmatter.id);
        this.trackMemoryAccess(memoryIds);

        const lines = recent.map(
          (m) => `- [${m.frontmatter.category}] ${m.content}`,
        );
        sections.push(`## Recent Memories\n\n${lines.join("\n")}`);
      }
    }

    // 3. TRANSCRIPT INJECTION (NEW)
    log.debug(`recall: transcriptEnabled=${this.config.transcriptEnabled}, sessionKey=${sessionKey}`);
    if (this.config.transcriptEnabled) {
      // Try checkpoint first (post-compaction recovery)
      let checkpointInjected = false;
      if (this.config.checkpointEnabled) {
        const checkpoint = await this.transcript.loadCheckpoint(sessionKey);
        log.debug(`recall: checkpoint loaded, turns=${checkpoint?.turns?.length ?? 0}`);
        if (checkpoint && checkpoint.turns.length > 0) {
          const formatted = this.transcript.formatForRecall(
            checkpoint.turns,
            this.config.maxTranscriptTokens
          );
          if (formatted) {
            sections.push(`## Working Context (Recovered)\n\n${formatted}`);
            checkpointInjected = true;
            // Clear checkpoint after injection
            await this.transcript.clearCheckpoint();
          }
        }
      }

      // If no checkpoint, inject recent transcript
      if (!checkpointInjected) {
        const entries = await this.transcript.readRecent(
          this.config.transcriptRecallHours,
          sessionKey
        );
        log.debug(`recall: read ${entries.length} transcript entries for sessionKey=${sessionKey}`);

        // Apply max turns cap
        const cappedEntries = entries.slice(-this.config.maxTranscriptTurns);

        if (cappedEntries.length > 0) {
          log.debug(`recall: injecting ${cappedEntries.length} transcript entries`);
          const formatted = this.transcript.formatForRecall(
            cappedEntries,
            this.config.maxTranscriptTokens
          );
          if (formatted) {
            sections.push(formatted);
          }
        }
      }
    }

    // 4. HOURLY SUMMARIES INJECTION (NEW)
    if (this.config.hourlySummariesEnabled && sessionKey) {
      const summaries = await this.summarizer.readRecent(
        sessionKey,
        this.config.summaryRecallHours
      );

      // Apply max count cap
      const cappedSummaries = summaries.slice(0, this.config.maxSummaryCount);

      if (cappedSummaries.length > 0) {
        const formatted = this.summarizer.formatForRecall(
          cappedSummaries,
          this.config.maxSummaryCount
        );
        sections.push(formatted);
      }
    }

    // 5. Inject most relevant question (if enabled) (existing)
    if (this.config.injectQuestions) {
      const questions = await this.storage.readQuestions({ unresolvedOnly: true });
      if (questions.length > 0) {
        // Find the most relevant question to the current prompt
        // Simple approach: use the highest-priority unresolved question
        // TODO: Could use QMD search to find the most contextually relevant one
        const topQuestion = questions[0]; // Already sorted by priority desc
        sections.push(`## Open Question\n\nSomething I've been curious about: ${topQuestion.question}\n\n_Context: ${topQuestion.context}_`);
      }
    }

    if (sections.length === 0) return "";

    return sections.join("\n\n---\n\n");
  }

  async processTurn(
    role: "user" | "assistant",
    content: string,
    sessionKey?: string,
  ): Promise<void> {
    const turn: BufferTurn = {
      role,
      content,
      timestamp: new Date().toISOString(),
      sessionKey,
    };

    const decision = await this.buffer.addTurn(turn);

    if (decision === "keep_buffering") return;

    // Queue extraction for background processing (agent_end returns immediately)
    // Capture the current buffer turns in a closure
    const turnsToExtract = this.buffer.getTurns();
    this.extractionQueue.push(async () => {
      await this.runExtraction(turnsToExtract);
    });

    // Start background processor if not already running
    if (!this.queueProcessing) {
      this.queueProcessing = true;
      this.processQueue().catch(err => {
        log.error("background extraction queue processor failed", err);
        this.queueProcessing = false;
      });
    }
  }

  /**
   * Background serial queue processor.
   * Processes extractions one at a time to avoid race conditions.
   * Called automatically when items are queued.
   */
  private async processQueue(): Promise<void> {
    while (this.extractionQueue.length > 0) {
      const task = this.extractionQueue.shift();
      if (task) {
        try {
          await task();
        } catch (err) {
          log.error("background extraction task failed", err);
        }
      }
    }

    this.queueProcessing = false;
  }

  private async runExtraction(turns: BufferTurn[]): Promise<void> {
    log.debug(`running extraction on ${turns.length} turns`);

    // Skip extraction for cron job sessions - these are system operations, not user conversations
    const sessionKey = turns[0]?.sessionKey ?? "";
    if (sessionKey.includes(":cron:")) {
      log.debug(`skipping extraction for cron session: ${sessionKey}`);
      await this.buffer.clearAfterExtraction();
      return;
    }

    // Pass existing entity names so the LLM can reuse them instead of inventing variants
    const existingEntities = await this.storage.listEntityNames();
    const result = await this.extraction.extract(turns, existingEntities);

    // Defensive: validate extraction result before processing
    if (!result) {
      log.warn("runExtraction: extraction returned null/undefined");
      await this.buffer.clearAfterExtraction();
      return;
    }
    if (!Array.isArray(result.facts)) {
      log.warn("runExtraction: extraction returned invalid facts (not an array)", { factsType: typeof result.facts, resultKeys: Object.keys(result) });
      await this.buffer.clearAfterExtraction();
      return;
    }

    const persistedIds = await this.persistExtraction(result);
    await this.buffer.clearAfterExtraction();

    // Process threading if enabled (Phase 3B)
    if (this.config.threadingEnabled && turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      const threadId = await this.threading.processTurn(lastTurn, persistedIds);

      // Update thread title with conversation content
      const conversationContent = turns.map((t) => t.content).join(" ");
      await this.threading.updateThreadTitle(threadId, conversationContent);
    }

    // Check if consolidation is needed
    const meta = await this.storage.loadMeta();
    const extractionCount = this.buffer.getExtractionCount();

    if (extractionCount > 0 && extractionCount % this.config.consolidateEveryN === 0) {
      // Run consolidation in background (don't await)
      this.runConsolidation().catch((err) =>
        log.error("background consolidation failed", err),
      );
    }

    // Update meta (safely handle potentially invalid result)
    meta.extractionCount += 1;
    meta.lastExtractionAt = new Date().toISOString();
    meta.totalMemories += Array.isArray(result?.facts) ? result.facts.length : 0;
    meta.totalEntities += Array.isArray(result?.entities) ? result.entities.length : 0;
    await this.storage.saveMeta(meta);

    // Trigger QMD re-index in background
    if (this.config.qmdEnabled && this.qmd.isAvailable()) {
      this.qmd.update().catch((err) =>
        log.debug(`background qmd update failed: ${err}`),
      );
    }
  }

  private async persistExtraction(result: ExtractionResult): Promise<string[]> {
    const persistedIds: string[] = [];

    // Defensive: validate result and facts array
    if (!result || !Array.isArray(result.facts)) {
      log.warn("persistExtraction: result or result.facts is invalid, skipping", { resultType: typeof result, factsType: typeof result?.facts });
      return persistedIds;
    }

    // Chunking config from plugin settings
    const chunkingConfig: ChunkingConfig = {
      targetTokens: this.config.chunkingTargetTokens,
      minTokens: this.config.chunkingMinTokens,
      overlapSentences: this.config.chunkingOverlapSentences,
    };

    for (const fact of result.facts) {
      // Score importance using local heuristics (Phase 1B)
      const importance = scoreImportance(fact.content, fact.category, fact.tags);

      // Check if chunking is enabled and content should be chunked
      if (this.config.chunkingEnabled) {
        const chunkResult = chunkContent(fact.content, chunkingConfig);

        if (chunkResult.chunked && chunkResult.chunks.length > 1) {
          // Write the parent memory first (with full content for reference)
          const parentId = await this.storage.writeMemory(fact.category, fact.content, {
            confidence: fact.confidence,
            tags: [...fact.tags, "chunked"],
            entityRef: fact.entityRef,
            source: "extraction",
            importance,
          });

          // Write individual chunks with parent reference
          for (const chunk of chunkResult.chunks) {
            // Score each chunk's importance separately
            const chunkImportance = scoreImportance(chunk.content, fact.category, fact.tags);

            await this.storage.writeChunk(
              parentId,
              chunk.index,
              chunkResult.chunks.length,
              fact.category,
              chunk.content,
              {
                confidence: fact.confidence,
                tags: fact.tags,
                entityRef: fact.entityRef,
                source: "chunking",
                importance: chunkImportance,
              },
            );
          }

          log.debug(`chunked memory ${parentId} into ${chunkResult.chunks.length} chunks`);
          persistedIds.push(parentId);
          continue; // Skip the normal write below
        }
      }

      // Check for contradictions before writing (Phase 2B)
      let supersedes: string | undefined;
      let links: MemoryLink[] = [];

      if (this.config.contradictionDetectionEnabled && this.qmd.isAvailable()) {
        const contradiction = await this.checkForContradiction(fact.content, fact.category);
        if (contradiction) {
          supersedes = contradiction.supersededId;
          links.push({
            targetId: contradiction.supersededId,
            linkType: "contradicts",
            strength: contradiction.confidence,
            reason: contradiction.reason,
          });
        }
      }

      // Suggest links for this memory (Phase 3A)
      if (this.config.memoryLinkingEnabled && this.qmd.isAvailable()) {
        const suggestedLinks = await this.suggestLinksForMemory(fact.content, fact.category);
        if (suggestedLinks.length > 0) {
          links.push(...suggestedLinks);
        }
      }

      // Normal write (no chunking)
      const memoryId = await this.storage.writeMemory(fact.category, fact.content, {
        confidence: fact.confidence,
        tags: fact.tags,
        entityRef: fact.entityRef,
        source: "extraction",
        importance,
        supersedes,
        links: links.length > 0 ? links : undefined,
      });
      persistedIds.push(memoryId);
    }

    for (const entity of result.entities) {
      await this.storage.writeEntity(entity.name, entity.type, entity.facts);
    }

    if (result.profileUpdates.length > 0) {
      await this.storage.appendToProfile(result.profileUpdates);
    }

    // Persist questions
    for (const q of result.questions) {
      await this.storage.writeQuestion(q.question, q.context, q.priority);
    }

    // Persist identity reflection
    if (this.config.identityEnabled && result.identityReflection) {
      try {
        await this.storage.appendToIdentity(this.config.workspaceDir, result.identityReflection);
      } catch (err) {
        log.debug(`identity reflection write failed: ${err}`);
      }
    }

    log.info(
      `persisted: ${result.facts.length} facts, ${result.entities.length} entities, ${result.questions.length} questions, ${result.profileUpdates.length} profile updates`,
    );

    // Return the persisted fact IDs for threading
    return persistedIds;
  }

  /** IDs of facts persisted in the last extraction */
  private lastPersistedIds: string[] = [];

  private async runConsolidation(): Promise<void> {
    log.info("running consolidation pass");

    // Flush access tracking buffer first
    if (this.accessTrackingBuffer.size > 0) {
      await this.flushAccessTracking();
    }

    const allMemories = await this.storage.readAllMemories();
    if (allMemories.length < 5) return;

    const recent = allMemories
      .sort(
        (a, b) =>
          new Date(b.frontmatter.created).getTime() -
          new Date(a.frontmatter.created).getTime(),
      )
      .slice(0, 20);

    const older = allMemories
      .sort(
        (a, b) =>
          new Date(a.frontmatter.created).getTime() -
          new Date(b.frontmatter.created).getTime(),
      );

    const profile = await this.storage.readProfile();
    const result = await this.extraction.consolidate(recent, older, profile);

    for (const item of result.items) {
      switch (item.action) {
        case "INVALIDATE":
          await this.storage.invalidateMemory(item.existingId);
          break;
        case "UPDATE":
          if (item.updatedContent) {
            await this.storage.updateMemory(item.existingId, item.updatedContent, {
              lineage: [item.existingId],
            });
          }
          break;
        case "MERGE":
          if (item.updatedContent && item.mergeWith) {
            await this.storage.updateMemory(item.existingId, item.updatedContent, {
              supersedes: item.mergeWith,
              lineage: [item.existingId, item.mergeWith],
            });
            await this.storage.invalidateMemory(item.mergeWith);
          }
          break;
      }
    }

    if (result.profileUpdates.length > 0) {
      await this.storage.appendToProfile(result.profileUpdates);
    }

    for (const entity of result.entityUpdates) {
      await this.storage.writeEntity(entity.name, entity.type, entity.facts);
    }

    // Merge fragmented entity files
    const entitiesMerged = await this.storage.mergeFragmentedEntities();
    if (entitiesMerged > 0) {
      log.info(`merged ${entitiesMerged} fragmented entity files`);
    }

    // Clean expired commitments
    const cleaned = await this.storage.cleanExpiredCommitments(this.config.commitmentDecayDays);
    if (cleaned > 0) {
      log.info(`cleaned ${cleaned} expired commitments`);
    }

    // Clean memories past their TTL (speculative memories auto-expire)
    const ttlCleaned = await this.storage.cleanExpiredTTL();
    if (ttlCleaned > 0) {
      log.info(`cleaned ${ttlCleaned} TTL-expired memories`);
    }

    // Auto-consolidate IDENTITY.md if it's getting large
    if (this.config.identityEnabled) {
      await this.autoConsolidateIdentity();
    }

    // Auto-consolidate profile.md if it exceeds max lines
    if (await this.storage.profileNeedsConsolidation()) {
      log.info("profile.md exceeds max lines — running smart consolidation");
      const currentProfile = await this.storage.readProfile();
      if (currentProfile) {
        const profileResult = await this.extraction.consolidateProfile(currentProfile);
        if (profileResult) {
          await this.storage.writeProfile(profileResult.consolidatedProfile);
          log.info(`profile.md consolidated: removed ${profileResult.removedCount} items — ${profileResult.summary}`);
        }
      }
    }

    // Memory Summarization (Phase 4A)
    if (this.config.summarizationEnabled) {
      await this.runSummarization(allMemories);
    }

    // Topic Extraction (Phase 4B)
    if (this.config.topicExtractionEnabled) {
      await this.runTopicExtraction(allMemories);
    }

    const meta = await this.storage.loadMeta();
    meta.lastConsolidationAt = new Date().toISOString();
    await this.storage.saveMeta(meta);

    log.info("consolidation complete");
  }

  /**
   * Run memory summarization if memory count exceeds threshold (Phase 4A).
   */
  private async runSummarization(allMemories: import("./types.js").MemoryFile[]): Promise<void> {
    // Only active memories count toward the threshold
    const activeMemories = allMemories.filter(
      (m) => !m.frontmatter.status || m.frontmatter.status === "active",
    );

    if (activeMemories.length < this.config.summarizationTriggerCount) {
      return;
    }

    log.info(`memory count (${activeMemories.length}) exceeds threshold (${this.config.summarizationTriggerCount}) — running summarization`);

    // Sort by creation date, oldest first
    const sorted = activeMemories.sort(
      (a, b) =>
        new Date(a.frontmatter.created).getTime() -
        new Date(b.frontmatter.created).getTime(),
    );

    // Keep recent memories
    const toKeep = sorted.slice(-this.config.summarizationRecentToKeep);
    const toSummarize = sorted.slice(0, -this.config.summarizationRecentToKeep);

    // Filter candidates for summarization
    const candidates = toSummarize.filter((m) => {
      // Skip if protected by entity reference
      if (m.frontmatter.entityRef) return false;

      // Skip if protected by tag
      const protectedTags = this.config.summarizationProtectedTags;
      if (m.frontmatter.tags.some((t) => protectedTags.includes(t))) return false;

      // Skip if importance is above threshold
      const importance = m.frontmatter.importance?.score ?? 0.5;
      if (importance >= this.config.summarizationImportanceThreshold) return false;

      return true;
    });

    if (candidates.length < 50) {
      log.debug(`only ${candidates.length} candidates for summarization — skipping`);
      return;
    }

    // Summarize in batches of 50
    const batchSize = 50;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchData = batch.map((m) => ({
        id: m.frontmatter.id,
        content: m.content,
        category: m.frontmatter.category,
        created: m.frontmatter.created,
      }));

      const result = await this.extraction.summarizeMemories(batchData);
      if (!result) continue;

      // Create summary
      const summary: MemorySummary = {
        id: `summary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
        timeRangeStart: batch[0].frontmatter.created,
        timeRangeEnd: batch[batch.length - 1].frontmatter.created,
        summaryText: result.summaryText,
        keyFacts: result.keyFacts,
        keyEntities: result.keyEntities,
        sourceEpisodeIds: batch.map((m) => m.frontmatter.id),
      };

      await this.storage.writeSummary(summary);

      // Archive source memories
      const archived = await this.storage.archiveMemories(
        batch.map((m) => m.frontmatter.id),
        summary.id,
      );

      log.info(`created summary ${summary.id} from ${batch.length} memories, archived ${archived}`);
    }
  }

  /**
   * Run topic extraction on all memories (Phase 4B).
   */
  private async runTopicExtraction(allMemories: import("./types.js").MemoryFile[]): Promise<void> {
    // Only extract from active memories
    const activeMemories = allMemories.filter(
      (m) => !m.frontmatter.status || m.frontmatter.status === "active",
    );

    if (activeMemories.length === 0) return;

    const topics = extractTopics(activeMemories, this.config.topicExtractionTopN);
    await this.storage.saveTopics(topics);

    log.debug(`extracted ${topics.length} topics from ${activeMemories.length} memories`);
  }

  /** Threshold (bytes) at which IDENTITY.md reflections get auto-consolidated */
  private static readonly IDENTITY_CONSOLIDATE_THRESHOLD = 8_000;

  private async autoConsolidateIdentity(): Promise<void> {
    const identityContent = await this.storage.readIdentity(this.config.workspaceDir);
    if (identityContent.length < Orchestrator.IDENTITY_CONSOLIDATE_THRESHOLD) return;

    log.info(`IDENTITY.md is ${identityContent.length} chars — auto-consolidating reflections`);

    // Find the static header (everything before reflections)
    const reflectionIdx = identityContent.indexOf("## Learned Patterns");
    const headerEnd = reflectionIdx !== -1 ? reflectionIdx : identityContent.indexOf("## Reflection");
    if (headerEnd === -1) {
      log.debug("no reflections found in IDENTITY.md, skipping consolidation");
      return;
    }

    const staticHeader = identityContent.slice(0, headerEnd).trimEnd();

    const result = await this.extraction.consolidateIdentity(
      identityContent,
      "## Reflection",
    );

    if (!result || result.learnedPatterns.length === 0) {
      log.warn("identity consolidation produced no patterns");
      return;
    }

    // Rebuild IDENTITY.md: static header + consolidated patterns
    const patternsSection = [
      "## Learned Patterns (consolidated from reflections, " + new Date().toISOString().slice(0, 10) + ")",
      "",
      ...result.learnedPatterns.map((p) => `- ${p}`),
      "",
    ].join("\n");

    const newContent = staticHeader + "\n\n" + patternsSection + "\n";

    await this.storage.writeIdentity(this.config.workspaceDir, newContent);
    log.info(`IDENTITY.md consolidated: ${identityContent.length} → ${newContent.length} chars, ${result.learnedPatterns.length} patterns`);
  }

  private formatQmdResults(
    title: string,
    results: QmdSearchResult[],
  ): string {
    const lines = results.map((r, i) => {
      const snippet = r.snippet
        ? r.snippet.slice(0, 500).replace(/\n/g, " ")
        : "(no preview)";
      return `[${i + 1}] ${r.path} (score: ${r.score.toFixed(3)})\n${snippet}`;
    });
    return `## ${title}\n\n${lines.join("\n\n")}`;
  }

  // ---------------------------------------------------------------------------
  // Access Tracking (Phase 1A)
  // ---------------------------------------------------------------------------

  /**
   * Record that memories were accessed (retrieved).
   * Updates are batched in memory and flushed during consolidation.
   */
  trackMemoryAccess(memoryIds: string[]): void {
    if (!this.config.accessTrackingEnabled) return;

    const now = new Date().toISOString();
    for (const id of memoryIds) {
      const existing = this.accessTrackingBuffer.get(id);
      this.accessTrackingBuffer.set(id, {
        count: (existing?.count ?? 0) + 1,
        lastAccessed: now,
      });
    }

    // Flush if buffer exceeds max size
    if (this.accessTrackingBuffer.size >= this.config.accessTrackingBufferMaxSize) {
      this.flushAccessTracking().catch((err) =>
        log.debug(`background access tracking flush failed: ${err}`),
      );
    }
  }

  /**
   * Flush access tracking buffer to disk.
   * Called during consolidation or when buffer is full.
   */
  async flushAccessTracking(): Promise<void> {
    if (this.accessTrackingBuffer.size === 0) return;

    // Build entries from buffer, merging with existing counts
    const entries: AccessTrackingEntry[] = [];
    const memories = await this.storage.readAllMemories();
    const memoryMap = new Map(memories.map((m) => [m.frontmatter.id, m]));

    for (const [memoryId, update] of this.accessTrackingBuffer) {
      const memory = memoryMap.get(memoryId);
      const existingCount = memory?.frontmatter.accessCount ?? 0;
      entries.push({
        memoryId,
        newCount: existingCount + update.count,
        lastAccessed: update.lastAccessed,
      });
    }

    await this.storage.flushAccessTracking(entries);
    this.accessTrackingBuffer.clear();
    log.debug(`flushed ${entries.length} access tracking entries`);
  }

  /**
   * Apply recency, access count, and importance boosting to QMD search results.
   * Returns re-ranked results.
   */
  private async boostSearchResults(
    results: QmdSearchResult[],
  ): Promise<QmdSearchResult[]> {
    if (results.length === 0) return results;

    const now = Date.now();
    const memories = await this.storage.readAllMemories();
    const memoryByPath = new Map(memories.map((m) => [m.path, m]));

    // Calculate boosted scores
    const boosted = results.map((r) => {
      const memory = memoryByPath.get(r.path);
      let score = r.score;

      if (memory) {
        // Recency boost: exponential decay over 7 days
        if (this.config.recencyWeight > 0) {
          const createdAt = new Date(memory.frontmatter.created).getTime();
          const ageMs = now - createdAt;
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const halfLifeDays = 7;
          const recencyScore = Math.pow(0.5, ageDays / halfLifeDays);
          score =
            score * (1 - this.config.recencyWeight) +
            recencyScore * this.config.recencyWeight;
        }

        // Access count boost: log scale, capped
        if (this.config.boostAccessCount && memory.frontmatter.accessCount) {
          const accessBoost = Math.log10(memory.frontmatter.accessCount + 1) / 3;
          score += Math.min(accessBoost, 0.1); // Cap at 0.1 boost
        }

        // Importance boost (Phase 1B): higher importance = higher rank
        if (memory.frontmatter.importance) {
          const importanceScore = memory.frontmatter.importance.score;
          // Boost important memories, slightly penalize trivial ones
          // Scale: trivial (-0.05) to critical (+0.15)
          const importanceBoost = (importanceScore - 0.4) * 0.25;
          score += importanceBoost;
        }
      }

      return { ...r, score };
    });

    // Re-sort by boosted score
    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Extract memory IDs from QMD search results for access tracking.
   */
  private extractMemoryIdsFromResults(results: QmdSearchResult[]): string[] {
    // QMD results have paths like /path/to/fact-123.md
    // Extract the ID from the filename
    return results
      .map((r) => {
        const match = r.path.match(/([^/]+)\.md$/);
        return match ? match[1] : null;
      })
      .filter((id): id is string => id !== null);
  }

  // ---------------------------------------------------------------------------
  // Contradiction Detection (Phase 2B)
  // ---------------------------------------------------------------------------

  /**
   * Check if a new memory contradicts an existing one.
   * Uses QMD to find similar memories, then LLM to verify contradiction.
   */
  private async checkForContradiction(
    content: string,
    category: string,
  ): Promise<{ supersededId: string; confidence: number; reason: string } | null> {
    if (!this.qmd.isAvailable()) return null;

    // Search for similar memories
    const results = await this.qmd.search(content, undefined, 5);

    for (const result of results) {
      // Check similarity threshold
      if (result.score < this.config.contradictionSimilarityThreshold) {
        continue;
      }

      // Get the existing memory
      const memoryId = this.extractMemoryIdsFromResults([result])[0];
      if (!memoryId) continue;

      const existingMemory = await this.storage.getMemoryById(memoryId);
      if (!existingMemory) continue;

      // Skip already superseded memories
      if (existingMemory.frontmatter.status === "superseded") continue;

      // Verify contradiction with LLM
      const verification = await this.extraction.verifyContradiction(
        { content, category },
        {
          id: existingMemory.frontmatter.id,
          content: existingMemory.content,
          category: existingMemory.frontmatter.category,
          created: existingMemory.frontmatter.created,
        },
      );

      if (!verification) continue;

      // Check if it's a real contradiction with high confidence
      if (
        verification.isContradiction &&
        verification.confidence >= this.config.contradictionMinConfidence
      ) {
        // Auto-resolve if enabled
        if (this.config.contradictionAutoResolve) {
          // The new memory supersedes the old one (unless LLM said first is newer)
          if (verification.whichIsNewer !== "first") {
            await this.storage.supersedeMemory(
              existingMemory.frontmatter.id,
              "pending-new", // Will be updated after the new memory is written
              verification.reasoning,
            );

            return {
              supersededId: existingMemory.frontmatter.id,
              confidence: verification.confidence,
              reason: verification.reasoning,
            };
          }
        }

        log.info(
          `detected contradiction (confidence: ${verification.confidence}): ${existingMemory.frontmatter.id} vs new memory`,
        );
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Memory Linking (Phase 3A)
  // ---------------------------------------------------------------------------

  /**
   * Suggest links for a new memory based on similar existing memories.
   */
  private async suggestLinksForMemory(
    content: string,
    category: string,
  ): Promise<MemoryLink[]> {
    if (!this.qmd.isAvailable()) return [];

    // Search for related memories
    const results = await this.qmd.search(content, undefined, 5);
    if (results.length === 0) return [];

    // Get full memory details for candidates
    const candidates: Array<{ id: string; content: string; category: string }> = [];
    for (const result of results) {
      const memoryId = this.extractMemoryIdsFromResults([result])[0];
      if (!memoryId) continue;

      const memory = await this.storage.getMemoryById(memoryId);
      if (memory && memory.frontmatter.status !== "superseded") {
        candidates.push({
          id: memory.frontmatter.id,
          content: memory.content,
          category: memory.frontmatter.category,
        });
      }
    }

    if (candidates.length === 0) return [];

    // Ask LLM for link suggestions
    const suggestions = await this.extraction.suggestLinks(
      { content, category },
      candidates,
    );

    if (!suggestions || suggestions.links.length === 0) return [];

    // Convert to MemoryLink format
    return suggestions.links.map((link) => ({
      targetId: link.targetId,
      linkType: link.linkType,
      strength: link.strength,
      reason: link.reason || undefined,
    }));
  }
}
