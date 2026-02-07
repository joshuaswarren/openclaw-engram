import { log } from "./logger.js";
import { SmartBuffer } from "./buffer.js";
import { ExtractionEngine } from "./extraction.js";
import { QmdClient } from "./qmd.js";
import { StorageManager } from "./storage.js";
import type {
  BufferTurn,
  ExtractionResult,
  PluginConfig,
  QmdSearchResult,
} from "./types.js";

export class Orchestrator {
  readonly storage: StorageManager;
  readonly qmd: QmdClient;
  readonly buffer: SmartBuffer;
  private readonly extraction: ExtractionEngine;
  private readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
    this.storage = new StorageManager(config.memoryDir);
    this.qmd = new QmdClient(config.qmdCollection, config.qmdMaxResults);
    this.buffer = new SmartBuffer(config, this.storage);
    this.extraction = new ExtractionEngine(config);
  }

  async initialize(): Promise<void> {
    await this.storage.ensureDirectories();

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
    log.info("orchestrator initialized");
  }

  async recall(prompt: string): Promise<string> {
    const sections: string[] = [];

    // Read profile directly (free, instant)
    const profile = await this.storage.readProfile();
    if (profile) {
      sections.push(`## User Profile\n\n${profile}`);
    }

    // Search memory collection via QMD
    if (this.config.qmdEnabled && this.qmd.isAvailable()) {
      const memoryResults = await this.qmd.search(prompt);
      if (memoryResults.length > 0) {
        sections.push(this.formatQmdResults("Relevant Memories", memoryResults));
      }

      // Search global collections for workspace context
      const globalResults = await this.qmd.searchGlobal(prompt, 6);
      if (globalResults.length > 0) {
        sections.push(
          this.formatQmdResults("Workspace Context", globalResults),
        );
      }
    } else {
      // Fallback: read recent memories directly
      const memories = await this.storage.readAllMemories();
      if (memories.length > 0) {
        const recent = memories
          .sort(
            (a, b) =>
              new Date(b.frontmatter.updated).getTime() -
              new Date(a.frontmatter.updated).getTime(),
          )
          .slice(0, 10);
        const lines = recent.map(
          (m) => `- [${m.frontmatter.category}] ${m.content}`,
        );
        sections.push(`## Recent Memories\n\n${lines.join("\n")}`);
      }
    }

    // Inject most relevant question (if enabled)
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

    const turns = this.buffer.getTurns();
    await this.runExtraction(turns);
  }

  private async runExtraction(turns: BufferTurn[]): Promise<void> {
    log.info(`running extraction on ${turns.length} turns`);

    const result = await this.extraction.extract(turns);
    await this.persistExtraction(result);
    await this.buffer.clearAfterExtraction();

    // Check if consolidation is needed
    const meta = await this.storage.loadMeta();
    const extractionCount = this.buffer.getExtractionCount();

    if (extractionCount > 0 && extractionCount % this.config.consolidateEveryN === 0) {
      // Run consolidation in background (don't await)
      this.runConsolidation().catch((err) =>
        log.error("background consolidation failed", err),
      );
    }

    // Update meta
    meta.extractionCount += 1;
    meta.lastExtractionAt = new Date().toISOString();
    meta.totalMemories += result.facts.length;
    meta.totalEntities += result.entities.length;
    await this.storage.saveMeta(meta);

    // Trigger QMD re-index in background
    if (this.config.qmdEnabled && this.qmd.isAvailable()) {
      this.qmd.update().catch((err) =>
        log.debug(`background qmd update failed: ${err}`),
      );
    }
  }

  private async persistExtraction(result: ExtractionResult): Promise<void> {
    for (const fact of result.facts) {
      await this.storage.writeMemory(fact.category, fact.content, {
        confidence: fact.confidence,
        tags: fact.tags,
        entityRef: fact.entityRef,
        source: "extraction",
      });
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
  }

  private async runConsolidation(): Promise<void> {
    log.info("running consolidation pass");
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

    const meta = await this.storage.loadMeta();
    meta.lastConsolidationAt = new Date().toISOString();
    await this.storage.saveMeta(meta);

    log.info("consolidation complete");
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
}
