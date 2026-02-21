import { log } from "./logger.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SmartBuffer } from "./buffer.js";
import { chunkContent, type ChunkingConfig } from "./chunking.js";
import { ExtractionEngine } from "./extraction.js";
import { scoreImportance } from "./importance.js";
import { QmdClient } from "./qmd.js";
import { StorageManager, ContentHashIndex, normalizeEntityName } from "./storage.js";
import { ThreadingManager } from "./threading.js";
import { extractTopics } from "./topics.js";
import { TranscriptManager } from "./transcript.js";
import { HourlySummarizer } from "./summarizer.js";
import { LocalLlmClient } from "./local-llm.js";
import { ModelRegistry } from "./model-registry.js";
import { expandQuery } from "./retrieval.js";
import { RerankCache, rerankLocalOrNoop } from "./rerank.js";
import { RelevanceStore } from "./relevance.js";
import { NegativeExampleStore } from "./negative.js";
import { LastRecallStore, type LastRecallSnapshot } from "./recall-state.js";
import { isDisagreementPrompt } from "./signal.js";
import { lintWorkspaceFiles, rotateMarkdownFileToArchive } from "./hygiene.js";
import { EmbeddingFallback } from "./embedding-fallback.js";
import { BootstrapEngine } from "./bootstrap.js";
import { inferIntentFromText, intentCompatibilityScore, planRecallMode } from "./intent.js";
import type { MemorySummary } from "./types.js";
import { chunkTranscriptEntries } from "./conversation-index/chunker.js";
import { writeConversationChunks } from "./conversation-index/indexer.js";
import { cleanupConversationChunks } from "./conversation-index/cleanup.js";
import { NamespaceStorageRouter } from "./namespaces/storage.js";
import {
  defaultNamespaceForPrincipal,
  recallNamespacesForPrincipal,
  resolvePrincipal,
} from "./namespaces/principal.js";
import { SharedContextManager } from "./shared-context/manager.js";
import { CompoundingEngine } from "./compounding/engine.js";
import type {
  AccessTrackingEntry,
  BootstrapOptions,
  BootstrapResult,
  BufferTurn,
  ExtractionResult,
  MemoryLink,
  MemoryFile,
  PluginConfig,
  QmdSearchResult,
  RecallPlanMode,
} from "./types.js";

export function isArtifactMemoryPath(filePath: string): boolean {
  return /(?:^|[\\/])artifacts(?:[\\/]|$)/i.test(filePath);
}

export function filterRecallCandidates(
  candidates: QmdSearchResult[],
  options: {
    namespacesEnabled: boolean;
    recallNamespaces: string[];
    resolveNamespace: (path: string) => string;
    limit: number;
  },
): QmdSearchResult[] {
  const scopedByNamespace = options.namespacesEnabled
    ? candidates.filter((r) => options.recallNamespaces.includes(options.resolveNamespace(r.path)))
    : candidates;
  return scopedByNamespace
    .filter((r) => !isArtifactMemoryPath(r.path))
    .slice(0, Math.max(0, options.limit));
}

export class Orchestrator {
  readonly storage: StorageManager;
  private readonly storageRouter: NamespaceStorageRouter;
  readonly qmd: QmdClient;
  private readonly conversationQmd?: QmdClient;
  readonly sharedContext?: SharedContextManager;
  readonly compounding?: CompoundingEngine;
  readonly buffer: SmartBuffer;
  readonly transcript: TranscriptManager;
  readonly summarizer: HourlySummarizer;
  readonly localLlm: LocalLlmClient;
  readonly modelRegistry: ModelRegistry;
  readonly relevance: RelevanceStore;
  readonly negatives: NegativeExampleStore;
  readonly lastRecall: LastRecallStore;
  readonly embeddingFallback: EmbeddingFallback;
  private readonly conversationIndexDir: string;
  private readonly extraction: ExtractionEngine;
  readonly config: PluginConfig;
  private readonly threading: ThreadingManager;
  private readonly rerankCache = new RerankCache();
  private contentHashIndex: ContentHashIndex | null = null;
  private readonly artifactSourceStatusCache = new WeakMap<
    StorageManager,
    {
      loadedAtMs: number;
      statusVersion: number;
      statuses: Map<string, "active" | "superseded" | "archived" | "missing">;
    }
  >();
  private static readonly ARTIFACT_STATUS_CACHE_TTL_MS = 60_000;

  // Access tracking buffer (Phase 1A)
  // Maps memoryId -> {count, lastAccessed} for batched updates
  private accessTrackingBuffer: Map<string, { count: number; lastAccessed: string }> =
    new Map();

  // Background serial queue for extractions (agent_end optimization)
  // Queue stores promises that resolve when extraction should run
  private extractionQueue: Array<() => Promise<void>> = [];
  private queueProcessing = false;
  private recentExtractionFingerprints = new Map<string, number>();
  private nonZeroExtractionsSinceConsolidation = 0;
  private lastConsolidationRunAtMs = 0;
  private consolidationInFlight = false;
  private qmdMaintenanceTimer: NodeJS.Timeout | null = null;
  private qmdMaintenancePending = false;
  private qmdMaintenanceInFlight = false;
  private lastQmdEmbedAtMs = 0;
  private readonly conversationIndexLastUpdateAtMs = new Map<string, number>();
  private lastFileHygieneRunAtMs = 0;
  private lastRecallFailureLogAtMs = 0;
  private lastRecallFailureAtMs = 0;
  private suppressedRecallFailures = 0;

  // Initialization gate: recall() awaits this before proceeding
  private initPromise: Promise<void> | null = null;
  private resolveInit: (() => void) | null = null;
  constructor(config: PluginConfig) {
    this.config = config;
    this.storageRouter = new NamespaceStorageRouter(config);
    this.storage = new StorageManager(config.memoryDir);
    this.qmd = new QmdClient(config.qmdCollection, config.qmdMaxResults, {
      slowLog: {
        enabled: config.slowLogEnabled,
        thresholdMs: config.slowLogThresholdMs,
      },
      updateTimeoutMs: config.qmdUpdateTimeoutMs,
      qmdPath: config.qmdPath,
      daemonUrl: config.qmdDaemonEnabled ? config.qmdDaemonUrl : undefined,
      daemonRecheckIntervalMs: config.qmdDaemonRecheckIntervalMs,
    });
    this.conversationQmd =
      config.conversationIndexEnabled && config.conversationIndexBackend === "qmd"
        ? new QmdClient(
            config.conversationIndexQmdCollection,
            Math.max(6, config.conversationRecallTopK),
            {
              slowLog: {
                enabled: config.slowLogEnabled,
                thresholdMs: config.slowLogThresholdMs,
              },
              updateTimeoutMs: config.qmdUpdateTimeoutMs,
              qmdPath: config.qmdPath,
              daemonUrl: config.qmdDaemonEnabled ? config.qmdDaemonUrl : undefined,
              daemonRecheckIntervalMs: config.qmdDaemonRecheckIntervalMs,
            },
          )
        : undefined;
    this.sharedContext = config.sharedContextEnabled ? new SharedContextManager(config) : undefined;
    this.compounding = config.compoundingEnabled ? new CompoundingEngine(config) : undefined;
    this.buffer = new SmartBuffer(config, this.storage);
    this.transcript = new TranscriptManager(config);
    this.conversationIndexDir = path.join(config.memoryDir, "conversation-index", "chunks");
    this.modelRegistry = new ModelRegistry(config.memoryDir);
    this.relevance = new RelevanceStore(config.memoryDir);
    this.negatives = new NegativeExampleStore(config.memoryDir);
    this.lastRecall = new LastRecallStore(config.memoryDir);
    this.embeddingFallback = new EmbeddingFallback(config);
    this.summarizer = new HourlySummarizer(config, config.gatewayConfig, this.modelRegistry, this.transcript);
    this.localLlm = new LocalLlmClient(config, this.modelRegistry);
    this.extraction = new ExtractionEngine(config, this.localLlm, config.gatewayConfig, this.modelRegistry);
    this.threading = new ThreadingManager(
      path.join(config.memoryDir, "threads"),
      config.threadingGapMinutes,
    );

    // Create init gate — recall() will await this before proceeding
    this.initPromise = new Promise<void>((resolve) => {
      this.resolveInit = resolve;
    });
  }

  private async resolveArtifactSourceStatuses(
    storage: StorageManager,
    sourceIds: string[],
  ): Promise<Map<string, "active" | "superseded" | "archived" | "missing">> {
    const currentStatusVersion = storage.getMemoryStatusVersion();
    const cached = this.artifactSourceStatusCache.get(storage);
    let snapshot = cached;
    const isFresh =
      snapshot !== undefined &&
      Date.now() - snapshot.loadedAtMs <= Orchestrator.ARTIFACT_STATUS_CACHE_TTL_MS &&
      snapshot.statusVersion === currentStatusVersion;

    const rebuildSnapshot = async () => {
      let versionBefore = storage.getMemoryStatusVersion();
      let allMemories = await storage.readAllMemories();
      let versionAfter = storage.getMemoryStatusVersion();

      // If status changed during snapshot read, refresh once to avoid a torn snapshot.
      if (versionAfter !== versionBefore) {
        versionBefore = storage.getMemoryStatusVersion();
        allMemories = await storage.readAllMemories();
        versionAfter = storage.getMemoryStatusVersion();
      }

      const rebuilt = {
        loadedAtMs: Date.now(),
        statusVersion: versionAfter,
        statuses: new Map(
          allMemories.map((m) => [
            m.frontmatter.id,
            (m.frontmatter.status ?? "active") as "active" | "superseded" | "archived" | "missing",
          ]),
        ),
      };
      this.artifactSourceStatusCache.set(storage, rebuilt);
      return rebuilt;
    };

    if (!isFresh) {
      snapshot = await rebuildSnapshot();
    } else {
      // Warm cache may miss brand-new sourceMemoryId values created after snapshot build.
      // Refresh once on-demand when unseen IDs are requested.
      const hasUnknownSourceIds = sourceIds.some((id) => !snapshot?.statuses.has(id));
      if (hasUnknownSourceIds) {
        snapshot = await rebuildSnapshot();
      }
    }

    // Persist negative lookups in the cached snapshot so stale source IDs do not
    // trigger repeated full snapshot rebuilds on every matching recall.
    for (const id of sourceIds) {
      if (!snapshot?.statuses.has(id)) {
        snapshot?.statuses.set(id, "missing");
      }
    }

    const statuses = new Map<string, "active" | "superseded" | "archived" | "missing">();
    for (const id of sourceIds) {
      const status = snapshot?.statuses.get(id);
      if (status) {
        statuses.set(id, status);
      } else {
        statuses.set(id, "missing");
      }
    }
    return statuses;
  }

  async initialize(): Promise<void> {
    await this.storage.ensureDirectories();
    await this.storage.loadAliases();
    if (this.config.namespacesEnabled) {
      const namespaces = new Set<string>([
        this.config.defaultNamespace,
        this.config.sharedNamespace,
        ...this.config.namespacePolicies.map((p) => p.name),
      ]);
      for (const ns of namespaces) {
        const sm = await this.storageRouter.storageFor(ns);
        await sm.ensureDirectories();
        await sm.loadAliases().catch(() => undefined);
      }
    }
    await this.relevance.load();
    await this.negatives.load();
    await this.lastRecall.load();

    // Initialize content-hash dedup index
    if (this.config.factDeduplicationEnabled) {
      const stateDir = path.join(this.config.memoryDir, "state");
      this.contentHashIndex = new ContentHashIndex(stateDir);
      await this.contentHashIndex.load();
      log.info(`content-hash dedup: loaded ${this.contentHashIndex.size} hashes`);
    }
    await this.transcript.initialize();
    await this.summarizer.initialize();
    if (this.sharedContext) {
      await this.sharedContext.ensureStructure();
    }
    if (this.compounding) {
      await this.compounding.ensureDirs();
    }

    if (this.config.qmdEnabled) {
      const available = await this.qmd.probe();
      if (available) {
        const mode = this.qmd.isDaemonMode() ? "daemon" : "subprocess";
        log.info(`QMD: available (mode: ${mode}) ${this.qmd.debugStatus()}`);
        const collectionState = await this.qmd.ensureCollection(this.config.memoryDir);
        if (collectionState === "missing") {
          this.config.qmdEnabled = false;
          log.warn(
            "QMD collection missing for Engram memory store; disabling QMD retrieval for this runtime (fallback retrieval remains enabled)",
          );
        } else if (collectionState === "unknown") {
          log.warn("QMD collection check unavailable; keeping QMD retrieval enabled for fail-open behavior");
        } else if (collectionState === "skipped") {
          log.debug("QMD collection check skipped in daemon-only mode");
        }
      } else {
        log.warn(`QMD: not available ${this.qmd.debugStatus()}`);
      }
    }

    if (this.config.conversationIndexEnabled && this.conversationQmd) {
      const available = await this.conversationQmd.probe();
      if (available) {
        log.info(`Conversation index QMD: available ${this.conversationQmd.debugStatus()}`);
        const collectionState = await this.conversationQmd.ensureCollection(
          path.join(this.config.memoryDir, "conversation-index"),
        );
        if (collectionState === "missing") {
          this.config.conversationIndexEnabled = false;
          log.warn(
            "Conversation index collection missing; disabling conversation semantic recall for this runtime",
          );
        } else if (collectionState === "unknown") {
          log.warn(
            "Conversation index collection check unavailable; keeping conversation semantic recall enabled for fail-open behavior",
          );
        } else if (collectionState === "skipped") {
          log.debug("Conversation index collection check skipped in daemon-only mode");
        }
      } else {
        log.warn(`Conversation index QMD: not available ${this.conversationQmd.debugStatus()}`);
      }
    }

    await this.buffer.load();

    // Validate local LLM model configuration
    if (this.config.localLlmEnabled) {
      await this.validateLocalLlmModel();
    }

    log.info("orchestrator initialized");

    // Open the init gate — any recall() calls waiting on this will proceed
    if (this.resolveInit) {
      this.resolveInit();
      this.resolveInit = null;
    }
  }

  async maybeRunFileHygiene(): Promise<void> {
    const hygiene = this.config.fileHygiene;
    if (!hygiene?.enabled) return;

    const now = Date.now();
    if (now - this.lastFileHygieneRunAtMs < hygiene.runMinIntervalMs) return;
    this.lastFileHygieneRunAtMs = now;

    // Rotation first (keeps bootstrap files small).
    if (hygiene.rotateEnabled) {
      for (const rel of hygiene.rotatePaths) {
        const abs = path.isAbsolute(rel) ? rel : path.join(this.config.workspaceDir, rel);
        try {
          const raw = await readFile(abs, "utf-8");
          if (raw.length > hygiene.rotateMaxBytes) {
            const archiveDir = path.join(this.config.workspaceDir, hygiene.archiveDir);
            const base = path.basename(abs);
            const prefix =
              base.toUpperCase().replace(/\.MD$/i, "").replace(/[^A-Z0-9]+/g, "-") || "FILE";
            const { newContent } = await rotateMarkdownFileToArchive({
              filePath: abs,
              archiveDir,
              archivePrefix: prefix,
              keepTailChars: hygiene.rotateKeepTailChars,
            });
            await writeFile(abs, newContent, "utf-8");
          }
        } catch {
          // ignore missing/unreadable targets
        }
      }
    }

    // Lint (warn before truncation risk).
    if (hygiene.lintEnabled) {
      const warnings = await lintWorkspaceFiles({
        workspaceDir: this.config.workspaceDir,
        paths: hygiene.lintPaths,
        budgetBytes: hygiene.lintBudgetBytes,
        warnRatio: hygiene.lintWarnRatio,
      });
      for (const w of warnings) {
        log.warn(w.message);
      }

      if (hygiene.warningsLogEnabled && warnings.length > 0) {
        const fp = path.join(this.config.memoryDir, hygiene.warningsLogPath);
        await mkdir(path.dirname(fp), { recursive: true });
        const stamp = new Date().toISOString();
        const block =
          `\n\n## ${stamp}\n\n` +
          warnings.map((w) => `- ${w.message}`).join("\n") +
          "\n";
        let existing = "";
        try {
          existing = await readFile(fp, "utf-8");
        } catch {
          existing = "# Engram File Hygiene Warnings\n";
        }
        await writeFile(fp, existing + block, "utf-8");
      }
    }
  }

  async runBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
    const engine = new BootstrapEngine(this.config, this);
    return engine.run(options);
  }

  async runConsolidationNow(): Promise<{ memoriesProcessed: number; merged: number; invalidated: number }> {
    return this.runConsolidation();
  }

  async waitForExtractionIdle(timeoutMs: number = 60_000): Promise<void> {
    const started = Date.now();
    while (this.queueProcessing || this.extractionQueue.length > 0) {
      if (Date.now() - started > timeoutMs) {
        log.warn(`waitForExtractionIdle timed out after ${timeoutMs}ms`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async getStorage(namespace?: string): Promise<StorageManager> {
    const ns = namespace && namespace.length > 0 ? namespace : this.config.defaultNamespace;
    return this.storageRouter.storageFor(ns);
  }

  async updateConversationIndex(
    sessionKey: string,
    hours: number = 24,
    opts?: { embed?: boolean; enforceMinInterval?: boolean },
  ): Promise<{ chunks: number; skipped: boolean; reason?: string; retryAfterMs?: number; embedded?: boolean }> {
    if (!this.config.conversationIndexEnabled) {
      return { chunks: 0, skipped: true, reason: "disabled", embedded: false };
    }
    const enforceMinInterval = opts?.enforceMinInterval !== false;
    if (enforceMinInterval) {
      const minIntervalMs = Math.max(0, this.config.conversationIndexMinUpdateIntervalMs);
      const now = Date.now();
      const last = this.conversationIndexLastUpdateAtMs.get(sessionKey) ?? 0;
      const elapsed = now - last;
      if (minIntervalMs > 0 && elapsed < minIntervalMs) {
        return {
          chunks: 0,
          skipped: true,
          reason: "min_interval",
          retryAfterMs: minIntervalMs - elapsed,
          embedded: false,
        };
      }
    }
    // Read transcript history and chunk it into markdown docs for QMD indexing.
    const entries = await this.transcript.readRecent(hours, sessionKey);
    const chunks = chunkTranscriptEntries(sessionKey, entries, {
      maxChars: this.config.conversationRecallMaxChars * 2,
      maxTurns: Math.max(10, this.config.hourlySummariesMaxTurnsPerRun),
    });
    await writeConversationChunks(this.conversationIndexDir, chunks);
    await cleanupConversationChunks(
      this.conversationIndexDir,
      this.config.conversationIndexRetentionDays,
    );
    // Best-effort: ask qmd to update indexes (will no-op if qmd missing).
    const q = this.conversationQmd ?? this.qmd;
    const usingPrimaryQmdClient = q === this.qmd;
    const shouldEmbed = opts?.embed ?? this.config.conversationIndexEmbedOnUpdate;
    let embedded = false;
    if ((!usingPrimaryQmdClient || this.config.qmdEnabled) && q.isAvailable()) {
      await q.update();
      if (shouldEmbed) {
        await q.embed();
        embedded = true;
      }
    }
    this.conversationIndexLastUpdateAtMs.set(sessionKey, Date.now());
    return { chunks: chunks.length, skipped: false, embedded };
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
    // Wait for initialization to complete before attempting recall.
    // Timeout after 15s in case initialize() never fires (edge case).
    if (this.initPromise) {
      const INIT_GATE_TIMEOUT_MS = 15_000;
      const gateResult = await Promise.race([
        this.initPromise.then(() => "ok" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), INIT_GATE_TIMEOUT_MS)),
      ]);
      if (gateResult === "timeout") {
        log.warn("recall: init gate timed out — proceeding without full init");
      }
    }

    // Keep outer recall timeout above worst-case serialized hybrid search:
    // QMD subprocess BM25 (30s) + vector (30s) can consume ~60s under contention.
    const RECALL_TIMEOUT_MS = 75_000;
    return Promise.race([
      this.recallInternal(prompt, sessionKey),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("recall timeout")), RECALL_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      this.logRecallFailure(err);
      return ""; // Return empty context on timeout/error
    });
  }

  private logRecallFailure(err: unknown): void {
    const now = Date.now();
    const errorMsg = err instanceof Error ? err.message : String(err);
    const LOG_WINDOW_MS = 60_000;
    const idleSinceLastFailureMs = now - this.lastRecallFailureAtMs;
    this.lastRecallFailureAtMs = now;
    if (idleSinceLastFailureMs >= LOG_WINDOW_MS) {
      this.suppressedRecallFailures = 0;
    }

    if (now - this.lastRecallFailureLogAtMs >= LOG_WINDOW_MS) {
      const suffix =
        this.suppressedRecallFailures > 0
          ? ` (suppressed ${this.suppressedRecallFailures} similar failures in last minute)`
          : "";
      log.warn(`recall timed out or failed: ${errorMsg}${suffix}`);
      this.lastRecallFailureLogAtMs = now;
      this.suppressedRecallFailures = 0;
      return;
    }

    this.suppressedRecallFailures += 1;
    log.debug(`recall timed out or failed (suppressed): ${errorMsg}`);
  }

  private artifactTypeForCategory(category: string): "decision" | "constraint" | "todo" | "definition" | "commitment" | "correction" | "fact" {
    if (category === "decision") return "decision";
    if (category === "commitment") return "commitment";
    if (category === "correction") return "correction";
    if (category === "principle") return "constraint";
    return "fact";
  }

  private truncateArtifactForRecall(text: string, maxChars = 280): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 1)}…`;
  }

  private async recallInternal(prompt: string, sessionKey?: string): Promise<string> {
    const recallStart = Date.now();
    const timings: Record<string, string> = {};
    const sections: string[] = [];
    const recallMode: RecallPlanMode = this.config.recallPlannerEnabled
      ? planRecallMode(prompt)
      : "full";
    timings.recallPlan = recallMode;
    const recallResultLimit = recallMode === "no_recall"
      ? 0
      : recallMode === "minimal"
      ? Math.max(0, Math.min(this.config.qmdMaxResults, this.config.recallPlannerMaxQmdResultsMinimal))
      : this.config.qmdMaxResults;
    const qmdFetchLimit = Math.max(
      recallResultLimit,
      Math.min(200, recallResultLimit + Math.max(12, this.config.verbatimArtifactsMaxRecall * 4)),
    );
    const embeddingFetchLimit = Math.max(
      recallResultLimit,
      Math.min(200, recallResultLimit + Math.max(12, this.config.verbatimArtifactsMaxRecall * 4)),
    );

    const principal = resolvePrincipal(sessionKey, this.config);
    const selfNamespace = defaultNamespaceForPrincipal(principal, this.config);
    const recallNamespaces = recallNamespacesForPrincipal(principal, this.config);
    const profileStorage = await this.storageRouter.storageFor(selfNamespace);

    // --- Phase 1: Launch ALL independent data fetches in parallel ---

    // 0. Shared context (v4.0, optional)
    const sharedContextPromise = (async (): Promise<string | null> => {
      if (!this.sharedContext) return null;
      const t0 = Date.now();
      const [priorities, roundtable] = await Promise.all([
        this.sharedContext.readPriorities(),
        this.sharedContext.readLatestRoundtable(),
      ]);
      const combined =
        [
          "## Shared Context",
          "",
          priorities ? "### Priorities\n\n" + priorities.trim() : "",
          roundtable ? "\n\n### Latest Roundtable\n\n" + roundtable.trim() : "",
        ]
          .filter((s) => s.trim().length > 0)
          .join("\n");

      const max = Math.max(500, this.config.sharedContextMaxInjectChars);
      const trimmed =
        combined.length > max ? combined.slice(0, max) + "\n\n...(trimmed)\n" : combined;
      timings.sharedCtx = `${Date.now() - t0}ms`;
      return trimmed.trim().length > 0 ? trimmed : null;
    })();

    // 1. Profile
    const profilePromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      const profile = await profileStorage.readProfile();
      timings.profile = `${Date.now() - t0}ms`;
      return profile || null;
    })();

    // 1b. Knowledge Index (v7.0)
    const knowledgeIndexPromise = (async (): Promise<{ result: string; cached: boolean } | null> => {
      if (!this.config.knowledgeIndexEnabled) return null;
      const t0 = Date.now();
      try {
        const ki = await this.storage.buildKnowledgeIndex(this.config);
        timings.ki = `${Date.now() - t0}ms${ki.cached ? " (cached)" : ""}`;
        return ki.result ? ki : null;
      } catch (err) {
        timings.ki = `${Date.now() - t0}ms (err)`;
        log.warn(`Knowledge Index build failed: ${err}`);
        return null;
      }
    })();

    // 1c. Verbatim artifacts (v8.0 phase 1)
    const artifactsPromise = (async (): Promise<MemoryFile[]> => {
      if (!this.config.verbatimArtifactsEnabled) return [];
      if (recallMode === "no_recall") return [];
      const t0 = Date.now();
      const targetCount = Math.max(0, this.config.verbatimArtifactsMaxRecall);
      if (targetCount <= 0) {
        timings.artifacts = "skip(limit=0)";
        return [];
      }
      const rawResults = await profileStorage.searchArtifacts(prompt, Number.MAX_SAFE_INTEGER);
      const sourceIds = Array.from(
        new Set(
          rawResults
            .map((a) => a.frontmatter.sourceMemoryId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      );
      const sourceStatus =
        sourceIds.length > 0
          ? await this.resolveArtifactSourceStatuses(profileStorage, sourceIds)
          : new Map<string, "active" | "superseded" | "archived" | "missing">();

      const results: MemoryFile[] = [];
      for (const artifact of rawResults) {
        const sourceId = artifact.frontmatter.sourceMemoryId;
        if (!sourceId) {
          results.push(artifact);
          if (results.length >= targetCount) break;
          continue;
        }
        const status = sourceStatus.get(sourceId) ?? "missing";
        if (status !== "active") continue;
        results.push(artifact);
        if (results.length >= targetCount) break;
      }

      timings.artifacts = `${Date.now() - t0}ms`;
      return results;
    })();

    // 2. QMD search (the slow part — runs in parallel with preamble)
    type QmdPhaseResult = {
      memoryResultsLists: QmdSearchResult[][];
      globalResults: QmdSearchResult[];
    } | null;

    const qmdPromise = (async (): Promise<QmdPhaseResult> => {
      if (recallMode === "no_recall") {
        timings.qmd = "skip(plan=no_recall)";
        return null;
      }
      if (recallResultLimit <= 0) {
        timings.qmd = "skip(limit=0)";
        return null;
      }
      if (!this.config.qmdEnabled || !this.qmd.isAvailable()) {
        timings.qmd = "skip";
        log.debug(`QMD skip: qmdEnabled=${this.config.qmdEnabled} ${this.qmd.debugStatus()}`);
        return null;
      }
      const t0 = Date.now();
      // Hybrid search: parallel BM25 + vector, merged by path.
      // Much faster than `qmd query` (LLM expansion + reranking) which
      // takes 30-70s and causes recall timeouts.
      const memoryResults = await this.qmd.hybridSearch(
        prompt,
        undefined,
        qmdFetchLimit,
      );

      timings.qmd = `${Date.now() - t0}ms`;
      return { memoryResultsLists: [memoryResults], globalResults: [] };
    })();

    // --- Wait for all parallel work ---
    const [sharedCtx, profile, kiResult, artifacts, qmdResult] = await Promise.all([
      sharedContextPromise,
      profilePromise,
      knowledgeIndexPromise,
      artifactsPromise,
      qmdPromise,
    ]);

    // --- Phase 2: Assemble sections in correct order ---

    // 0. Shared context
    if (sharedCtx) sections.push(sharedCtx);

    // 1. Profile
    if (profile) sections.push(`## User Profile\n\n${profile}`);

    // 1b. Knowledge Index
    if (kiResult?.result) {
      sections.push(kiResult.result);
      log.debug(`Knowledge Index: ${kiResult.result.split("\n").length - 4} entities, ${kiResult.result.length} chars${kiResult.cached ? " (cached)" : ""}`);
    }

    // 1c. Verbatim artifacts (quote-first anchors)
    if (artifacts.length > 0) {
      const lines = artifacts.map((a) => {
        const artifactType = a.frontmatter.artifactType ?? "fact";
        const createdRaw = typeof a.frontmatter.created === "string" ? a.frontmatter.created : "";
        const created = createdRaw ? createdRaw.slice(0, 19).replace("T", " ") : "unknown-time";
        return `- [${artifactType}] "${this.truncateArtifactForRecall(a.content)}" (${created})`;
      });
      sections.push(`## Verbatim Artifacts\n\n${lines.join("\n")}`);
    }

    // 2. QMD results — post-process and format
    if (qmdResult) {
      const t0 = Date.now();
      const { memoryResultsLists, globalResults } = qmdResult;

      // Merge/dedupe by path; keep the best score and first non-empty snippet.
      const mergedByPath = new Map<string, QmdSearchResult>();
      for (const list of memoryResultsLists) {
        for (const r of list) {
          const prev = mergedByPath.get(r.path);
          if (!prev) {
            mergedByPath.set(r.path, r);
            continue;
          }
          const better = r.score > prev.score ? r : prev;
          const snippet = prev.snippet || r.snippet;
          mergedByPath.set(r.path, { ...better, snippet });
        }
      }
      const memoryResultsRaw = Array.from(mergedByPath.values());

      let memoryResults = memoryResultsRaw;

      // Enforce namespace read policies by filtering paths.
      if (this.config.namespacesEnabled) {
        memoryResults = memoryResults.filter((r) =>
          recallNamespaces.includes(this.namespaceFromPath(r.path)),
        );
      }
      // Artifacts are injected through dedicated verbatim recall flow only.
      memoryResults = memoryResults.filter((r) => !isArtifactMemoryPath(r.path));

      // Apply recency and access count boosting
      memoryResults = await this.boostSearchResults(memoryResults, recallNamespaces, prompt);

      // Optional LLM reranking (default off). Fail-open if rerank fails/slow.
      if (this.config.rerankEnabled && this.config.rerankProvider === "local") {
        const ranked = await rerankLocalOrNoop({
          query: prompt,
          candidates: memoryResults.slice(0, this.config.rerankMaxCandidates).map((r) => ({
            id: r.path,
            snippet: r.snippet || r.path,
          })),
          local: this.localLlm,
          enabled: true,
          timeoutMs: this.config.rerankTimeoutMs,
          maxCandidates: this.config.rerankMaxCandidates,
          cache: this.rerankCache,
          cacheEnabled: this.config.rerankCacheEnabled,
          cacheTtlMs: this.config.rerankCacheTtlMs,
        });
        if (ranked && ranked.length > 0) {
          const byPath = new Map(memoryResults.map((r) => [r.path, r]));
          const reordered: QmdSearchResult[] = [];
          for (const p of ranked) {
            const it = byPath.get(p);
            if (it) reordered.push(it);
          }
          // Append any unranked items in original order.
          const rankedSet = new Set(ranked);
          for (const r of memoryResults) {
            if (!rankedSet.has(r.path)) reordered.push(r);
          }
          memoryResults = reordered;
        }
      }
      if (this.config.rerankEnabled && this.config.rerankProvider === "cloud") {
        log.debug("rerankProvider=cloud is reserved/experimental in v2.2.0; skipping rerank");
      }

      memoryResults = memoryResults.slice(0, recallResultLimit);

      if (memoryResults.length > 0) {
        // Track access for these memories
        const memoryIds = this.extractMemoryIdsFromResults(memoryResults);
        this.trackMemoryAccess(memoryIds);

        // Record last recall snapshot + impression log for feedback loops.
        if (sessionKey) {
          const unique = Array.from(new Set(memoryIds)).slice(0, 40);
          this.lastRecall
            .record({ sessionKey, query: prompt, memoryIds: unique })
            .catch((err) => log.debug(`last recall record failed: ${err}`));
        }

        sections.push(this.formatQmdResults("Relevant Memories", memoryResults));
      } else {
        const embeddingResults = await this.searchEmbeddingFallback(prompt, embeddingFetchLimit);
        const scoped = filterRecallCandidates(embeddingResults, {
          namespacesEnabled: this.config.namespacesEnabled,
          recallNamespaces,
          resolveNamespace: (p) => this.namespaceFromPath(p),
          limit: recallResultLimit,
        });
        if (scoped.length > 0) {
          const memoryIds = this.extractMemoryIdsFromResults(scoped);
          this.trackMemoryAccess(memoryIds);
          if (sessionKey) {
            const unique = Array.from(new Set(memoryIds)).slice(0, 40);
            this.lastRecall
              .record({ sessionKey, query: prompt, memoryIds: unique })
              .catch((err) => log.debug(`last recall record failed: ${err}`));
          }
          sections.push(this.formatQmdResults("Relevant Memories", scoped));
        }
      }

      if (globalResults.length > 0) {
        sections.push(
          this.formatQmdResults("Workspace Context", globalResults),
        );
      }

      timings.qmdPost = `${Date.now() - t0}ms`;

      // If the user is pushing back ("that's not right", "why did you say that"),
      // gently suggest an explicit workflow to inspect what was recalled and record feedback.
      // IMPORTANT: this is suggestion-only; never auto-mark negatives.
      if (isDisagreementPrompt(prompt)) {
        sections.push(
          [
            "## Retrieval Feedback Helper",
            "",
            "The user may be disputing an answer. To debug whether retrieval misled the response:",
            "- Use tool `memory_last_recall` to see which memory IDs were injected into context.",
            "- If negative examples are enabled, you can use `memory_feedback_last_recall` to mark specific recalled IDs as not useful.",
            "",
            "Safety: do not mass-mark negatives automatically; prefer explicit IDs.",
          ].join("\n"),
        );
      }
    } else if (
      recallResultLimit > 0 &&
      recallMode !== "no_recall" &&
      (!this.config.qmdEnabled || !this.qmd.isAvailable())
    ) {
      // Fallback: embeddings first, then recency-only.
      const embeddingResults = await this.searchEmbeddingFallback(prompt, embeddingFetchLimit);
      const scoped = filterRecallCandidates(embeddingResults, {
        namespacesEnabled: this.config.namespacesEnabled,
        recallNamespaces,
        resolveNamespace: (p) => this.namespaceFromPath(p),
        limit: recallResultLimit,
      });
      if (scoped.length > 0) {
        const memoryIds = this.extractMemoryIdsFromResults(scoped);
        this.trackMemoryAccess(memoryIds);
        if (sessionKey) {
          const unique = Array.from(new Set(memoryIds)).slice(0, 40);
          this.lastRecall
            .record({ sessionKey, query: prompt, memoryIds: unique })
            .catch((err) => log.debug(`last recall record failed: ${err}`));
        }
        sections.push(this.formatQmdResults("Relevant Memories", scoped));
      } else {
        const memories = await this.readAllMemoriesForNamespaces(recallNamespaces);
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
            .slice(0, recallResultLimit);

          // Track access for these memories
          const memoryIds = recent.map((m) => m.frontmatter.id);
          this.trackMemoryAccess(memoryIds);

          if (sessionKey) {
            const unique = Array.from(new Set(memoryIds)).slice(0, 40);
            this.lastRecall
              .record({ sessionKey, query: prompt, memoryIds: unique })
              .catch((err) => log.debug(`last recall record failed: ${err}`));
          }

          const lines = recent.map(
            (m) => `- [${m.frontmatter.category}] ${m.content}`,
          );
          sections.push(`## Recent Memories\n\n${lines.join("\n")}`);
        }
      }

      if (isDisagreementPrompt(prompt)) {
        sections.push(
          [
            "## Retrieval Feedback Helper",
            "",
            "The user may be disputing an answer. To debug whether retrieval misled the response:",
            "- Use tool `memory_last_recall` to see which memory IDs were injected into context.",
            "- If negative examples are enabled, you can use `memory_feedback_last_recall` to mark specific recalled IDs as not useful.",
            "",
            "Safety: do not mass-mark negatives automatically; prefer explicit IDs.",
          ].join("\n"),
        );
      }
    }

    // 3. TRANSCRIPT INJECTION (NEW)
    const transcriptT0 = Date.now();
    log.debug(`recall: transcriptEnabled=${this.config.transcriptEnabled}, sessionKey=${sessionKey}`);
    if (this.config.transcriptEnabled && recallMode !== "no_recall") {
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

    timings.transcript = `${Date.now() - transcriptT0}ms`;

    // 4. HOURLY SUMMARIES INJECTION (NEW)
    const summariesT0 = Date.now();
    if (this.config.hourlySummariesEnabled && sessionKey && recallMode !== "no_recall") {
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

    timings.summaries = `${Date.now() - summariesT0}ms`;

    // 4.5. Conversation semantic recall hook (optional, default off).
    // This searches over transcript chunk docs (ideally a separate QMD collection).
    const convT0 = Date.now();
    if (
      this.config.conversationIndexEnabled &&
      this.conversationQmd &&
      this.conversationQmd.isAvailable() &&
      recallMode !== "no_recall"
    ) {
      const startedAtMs = Date.now();
      const timeoutMs = Math.max(200, this.config.conversationRecallTimeoutMs);
      const topK = Math.max(1, this.config.conversationRecallTopK);
      const maxChars = Math.max(400, this.config.conversationRecallMaxChars);

      const results = (await Promise.race([
        this.conversationQmd.search(prompt, undefined, topK),
        new Promise<[]>(resolve => setTimeout(() => resolve([]), timeoutMs)),
      ]).catch(() => [])) as Array<{ path: string; snippet: string; score: number }>;

      const durationMs = Date.now() - startedAtMs;
      if (durationMs >= timeoutMs) {
        log.debug(`conversation recall: timed out after ${timeoutMs}ms`);
      }

      if (Array.isArray(results) && results.length > 0) {
        const lines: string[] = ["## Semantic Recall (Past Conversations)", ""];
        let used = 0;
        for (const r of results) {
          if (!r?.snippet) continue;
          const chunk =
            `### ${r.path}\n` +
            `Score: ${r.score.toFixed(3)}\n\n` +
            `${r.snippet.trim()}\n`;
          if (used + chunk.length > maxChars) break;
          lines.push(chunk);
          used += chunk.length;
        }
        if (used > 0) {
          sections.push(lines.join("\n"));
        }
      }
    }

    timings.convRecall = `${Date.now() - convT0}ms`;

    // 4.75. Compounding injection (v5.0, optional)
    if (this.compounding && this.config.compoundingInjectEnabled && recallMode !== "no_recall") {
      const mistakes = await this.compounding.readMistakes();
      if (mistakes && Array.isArray(mistakes.patterns) && mistakes.patterns.length > 0) {
        const lines: string[] = [
          "## Institutional Learning (Compounded)",
          "",
          "Avoid repeating these patterns:",
          ...mistakes.patterns.slice(0, 40).map((p) => `- ${p}`),
        ];
        sections.push(lines.join("\n"));
      }
    }

    // 5. Inject most relevant question (if enabled) (existing)
    if (this.config.injectQuestions && recallMode !== "no_recall") {
      const questions = await profileStorage.readQuestions({ unresolvedOnly: true });
      if (questions.length > 0) {
        // Find the most relevant question to the current prompt
        // Simple approach: use the highest-priority unresolved question
        // TODO: Could use QMD search to find the most contextually relevant one
        const topQuestion = questions[0]; // Already sorted by priority desc
        sections.push(`## Open Question\n\nSomething I've been curious about: ${topQuestion.question}\n\n_Context: ${topQuestion.context}_`);
      }
    }

    // --- Timing summary ---
    timings.total = `${Date.now() - recallStart}ms`;
    const timingParts = Object.entries(timings).map(([k, v]) => `${k}=${v}`).join(", ");
    log.debug(`recall: ${timingParts}`);

    if (sections.length === 0) return "";

    return sections.join("\n\n---\n\n");
  }

  async processTurn(
    role: "user" | "assistant",
    content: string,
    sessionKey?: string,
  ): Promise<void> {
    if (role !== "user" && role !== "assistant") {
      log.debug(`processTurn: ignoring unsupported role=${String(role)}`);
      return;
    }

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
    if (!this.shouldQueueExtraction(turnsToExtract)) {
      // We still clear buffered turns so the queue doesn't keep re-enqueueing duplicates.
      await this.buffer.clearAfterExtraction();
      return;
    }
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

  private shouldQueueExtraction(turns: BufferTurn[]): boolean {
    if (!this.config.extractionDedupeEnabled) return true;
    if (!Array.isArray(turns) || turns.length === 0) return false;

    // Fingerprint only user/assistant text; tool/system noise should not produce unique runs.
    const normalized = turns
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => `${t.role}:${(t.content ?? "").trim().slice(0, this.config.extractionMaxTurnChars)}`)
      .join("\n");
    if (!normalized) return false;

    const fingerprint = createHash("sha256").update(normalized).digest("hex");
    const now = Date.now();
    const seenAt = this.recentExtractionFingerprints.get(fingerprint);
    if (seenAt && now - seenAt < this.config.extractionDedupeWindowMs) {
      log.debug("extraction dedupe: skipped duplicate buffered turn set");
      return false;
    }

    this.recentExtractionFingerprints.set(fingerprint, now);
    // Keep this cache bounded to avoid unbounded growth.
    if (this.recentExtractionFingerprints.size > 200) {
      const entries = Array.from(this.recentExtractionFingerprints.entries()).sort(
        (a, b) => a[1] - b[1],
      );
      for (const [key] of entries.slice(0, entries.length - 200)) {
        this.recentExtractionFingerprints.delete(key);
      }
    }

    return true;
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

    const normalizedTurns = turns
      .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .map((t) => ({
        ...t,
        content: t.content.trim().slice(0, this.config.extractionMaxTurnChars),
      }))
      .filter((t) => t.content.length > 0);

    const userTurns = normalizedTurns.filter((t) => t.role === "user");
    const totalChars = normalizedTurns.reduce((sum, t) => sum + t.content.length, 0);
    if (
      totalChars < this.config.extractionMinChars ||
      userTurns.length < this.config.extractionMinUserTurns
    ) {
      log.debug(
        `skipping extraction: below threshold (totalChars=${totalChars}, userTurns=${userTurns.length})`,
      );
      await this.buffer.clearAfterExtraction();
      return;
    }

    const principal = resolvePrincipal(sessionKey, this.config);
    const selfNamespace = defaultNamespaceForPrincipal(principal, this.config);
    const storage = await this.storageRouter.storageFor(selfNamespace);

    // Pass existing entity names so the LLM can reuse them instead of inventing variants
    const existingEntities = await storage.listEntityNames();
    const result = await this.extraction.extract(normalizedTurns, existingEntities);

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
    if (
      result.facts.length === 0 &&
      result.entities.length === 0 &&
      result.questions.length === 0 &&
      result.profileUpdates.length === 0
    ) {
      log.debug("runExtraction: extraction produced no durable outputs; skipping persistence");
      await this.buffer.clearAfterExtraction();
      return;
    }

    const persistedIds = await this.persistExtraction(result, storage);
    await this.buffer.clearAfterExtraction();

    // Process threading if enabled (Phase 3B)
    if (this.config.threadingEnabled && turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      const threadId = await this.threading.processTurn(lastTurn, persistedIds);

      // Update thread title with conversation content
      const conversationContent = turns.map((t) => t.content).join(" ");
      await this.threading.updateThreadTitle(threadId, conversationContent);
    }

    // Check if consolidation is needed (debounced + non-zero gated).
    const nonZeroExtraction =
      result.facts.length > 0 ||
      result.entities.length > 0 ||
      result.questions.length > 0 ||
      result.profileUpdates.length > 0;
    if (nonZeroExtraction) this.nonZeroExtractionsSinceConsolidation += 1;
    this.maybeScheduleConsolidation(nonZeroExtraction);

    // Update meta (safely handle potentially invalid result)
    const meta = await storage.loadMeta();
    meta.extractionCount += 1;
    meta.lastExtractionAt = new Date().toISOString();
    meta.totalMemories += Array.isArray(result?.facts) ? result.facts.length : 0;
    meta.totalEntities += Array.isArray(result?.entities) ? result.entities.length : 0;
    await storage.saveMeta(meta);

    this.requestQmdMaintenance();
  }

  private maybeScheduleConsolidation(nonZeroExtraction: boolean): void {
    if (this.config.consolidationRequireNonZeroExtraction && !nonZeroExtraction) return;
    if (this.nonZeroExtractionsSinceConsolidation < this.config.consolidateEveryN) return;

    const now = Date.now();
    if (now - this.lastConsolidationRunAtMs < this.config.consolidationMinIntervalMs) return;
    if (this.consolidationInFlight) return;

    this.consolidationInFlight = true;
    this.lastConsolidationRunAtMs = now;
    this.nonZeroExtractionsSinceConsolidation = 0;
    this.runConsolidation()
      .catch((err) => log.error("background consolidation failed", err))
      .finally(() => {
        this.consolidationInFlight = false;
      });
  }

  private requestQmdMaintenance(): void {
    if (!this.config.qmdEnabled || !this.qmd.isAvailable()) return;
    if (!this.config.qmdMaintenanceEnabled) return;

    this.qmdMaintenancePending = true;
    if (this.qmdMaintenanceTimer) return;

    this.qmdMaintenanceTimer = setTimeout(() => {
      this.qmdMaintenanceTimer = null;
      this.runQmdMaintenance().catch((err) =>
        log.debug(`background qmd maintenance failed: ${err}`),
      );
    }, this.config.qmdMaintenanceDebounceMs);
  }

  /**
   * Public entrypoint for tool-driven QMD maintenance requests.
   * Routes through existing debounced/singleflight maintenance controls.
   */
  requestQmdMaintenanceForTool(reason: string): void {
    try {
      this.requestQmdMaintenance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`qmd maintenance request failed (${reason}): ${msg}`);
    }
  }

  private async runQmdMaintenance(): Promise<void> {
    if (this.qmdMaintenanceInFlight) return;
    if (!this.qmdMaintenancePending) return;
    this.qmdMaintenanceInFlight = true;
    this.qmdMaintenancePending = false;

    try {
      await this.qmd.update();
      const now = Date.now();
      if (
        this.config.qmdAutoEmbedEnabled &&
        now - this.lastQmdEmbedAtMs >= this.config.qmdEmbedMinIntervalMs
      ) {
        await this.qmd.embed();
        this.lastQmdEmbedAtMs = now;
      }
    } finally {
      this.qmdMaintenanceInFlight = false;
      if (this.qmdMaintenancePending) {
        this.requestQmdMaintenance();
      }
    }
  }

  private async persistExtraction(result: ExtractionResult, storage: StorageManager): Promise<string[]> {
    const persistedIds: string[] = [];
    let dedupedCount = 0;

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

    const rawEntities = Array.isArray((result as any).entities) ? (result as any).entities : [];
    const rawQuestions = Array.isArray((result as any).questions) ? (result as any).questions : [];
    const rawProfileUpdates = Array.isArray((result as any).profileUpdates)
      ? (result as any).profileUpdates
      : [];

    const facts = result.facts.slice(0, this.config.extractionMaxFactsPerRun);
    const entities = rawEntities.slice(0, this.config.extractionMaxEntitiesPerRun);
    const questions = rawQuestions.slice(0, this.config.extractionMaxQuestionsPerRun);
    const profileUpdates = rawProfileUpdates.slice(
      0,
      this.config.extractionMaxProfileUpdatesPerRun,
    );

    if (
      facts.length < result.facts.length ||
      entities.length < result.entities.length ||
      questions.length < result.questions.length ||
      profileUpdates.length < result.profileUpdates.length
    ) {
      log.warn(
        "persistExtraction: capped extraction payload to guardrails " +
          `(facts ${facts.length}/${result.facts.length}, entities ${entities.length}/${result.entities.length}, ` +
          `questions ${questions.length}/${result.questions.length}, profile ${profileUpdates.length}/${result.profileUpdates.length})`,
      );
    }

    for (const fact of facts) {
      if (!fact || typeof (fact as any).content !== "string" || !(fact as any).content.trim()) {
        continue;
      }
      if (typeof (fact as any).category !== "string" || !(fact as any).category.trim()) {
        continue;
      }
      (fact as any).tags = Array.isArray((fact as any).tags)
        ? (fact as any).tags.filter((t: any) => typeof t === "string")
        : [];
      (fact as any).confidence =
        typeof (fact as any).confidence === "number" ? (fact as any).confidence : 0.7;

      // Content-hash dedup check (v6.0)
      if (this.contentHashIndex && this.contentHashIndex.has(fact.content)) {
        log.debug(`dedup: skipping duplicate fact "${fact.content.slice(0, 60)}…"`);
        dedupedCount++;
        continue;
      }

      // Score importance using local heuristics (Phase 1B)
      const importance = scoreImportance(fact.content, fact.category, fact.tags);
      const inferredIntent = this.config.intentRoutingEnabled
        ? inferIntentFromText(`${fact.category} ${fact.tags.join(" ")} ${fact.content}`)
        : null;

      // Check if chunking is enabled and content should be chunked
      if (this.config.chunkingEnabled) {
        const chunkResult = chunkContent(fact.content, chunkingConfig);

        if (chunkResult.chunked && chunkResult.chunks.length > 1) {
          // Write the parent memory first (with full content for reference)
          const parentId = await storage.writeMemory(fact.category, fact.content, {
            confidence: fact.confidence,
            tags: [...fact.tags, "chunked"],
            entityRef: fact.entityRef,
            source: "extraction",
            importance,
            intentGoal: inferredIntent?.goal,
            intentActionType: inferredIntent?.actionType,
            intentEntityTypes: inferredIntent?.entityTypes,
          });

          // Write individual chunks with parent reference
          for (const chunk of chunkResult.chunks) {
            // Score each chunk's importance separately
            const chunkImportance = scoreImportance(chunk.content, fact.category, fact.tags);

            await storage.writeChunk(
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
                intentGoal: inferredIntent?.goal,
                intentActionType: inferredIntent?.actionType,
                intentEntityTypes: inferredIntent?.entityTypes,
              },
            );
          }

          log.debug(`chunked memory ${parentId} into ${chunkResult.chunks.length} chunks`);
          persistedIds.push(parentId);
          await this.indexPersistedMemory(storage, parentId);
          // Register chunked content in hash index too
          if (this.contentHashIndex) {
            this.contentHashIndex.add(fact.content);
          }

          for (const chunk of chunkResult.chunks) {
            await this.indexPersistedMemory(storage, `${parentId}-chunk-${chunk.index}`);
          }
          if (
            this.config.verbatimArtifactsEnabled &&
            this.config.verbatimArtifactCategories.includes(fact.category) &&
            fact.confidence >= this.config.verbatimArtifactsMinConfidence
          ) {
            await storage.writeArtifact(fact.content, {
              confidence: fact.confidence,
              tags: [...fact.tags, "artifact", "chunked-parent"],
              artifactType: this.artifactTypeForCategory(fact.category),
              sourceMemoryId: parentId,
              intentGoal: inferredIntent?.goal,
              intentActionType: inferredIntent?.actionType,
              intentEntityTypes: inferredIntent?.entityTypes,
            });
          }
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
      const memoryId = await storage.writeMemory(fact.category, fact.content, {
        confidence: fact.confidence,
        tags: fact.tags,
        entityRef: typeof (fact as any).entityRef === "string" ? (fact as any).entityRef : undefined,
        source: "extraction",
        importance,
        supersedes,
        links: links.length > 0 ? links : undefined,
        intentGoal: inferredIntent?.goal,
        intentActionType: inferredIntent?.actionType,
        intentEntityTypes: inferredIntent?.entityTypes,
      });
      persistedIds.push(memoryId);
      await this.indexPersistedMemory(storage, memoryId);
      if (
        this.config.verbatimArtifactsEnabled &&
        this.config.verbatimArtifactCategories.includes(fact.category) &&
        fact.confidence >= this.config.verbatimArtifactsMinConfidence
      ) {
        await storage.writeArtifact(fact.content, {
          confidence: fact.confidence,
          tags: [...fact.tags, "artifact"],
          artifactType: this.artifactTypeForCategory(fact.category),
          sourceMemoryId: memoryId,
          intentGoal: inferredIntent?.goal,
          intentActionType: inferredIntent?.actionType,
          intentEntityTypes: inferredIntent?.entityTypes,
        });
      }
      // Register in content-hash index after successful write
      if (this.contentHashIndex) {
        this.contentHashIndex.add(fact.content);
      }
    }

    for (const entity of entities) {
      try {
        const name = (entity as any)?.name;
        const type = (entity as any)?.type;
        if (typeof name !== "string" || !name.trim() || typeof type !== "string" || !type.trim()) {
          continue;
        }
        const safeFacts = Array.isArray((entity as any)?.facts)
          ? (entity as any).facts.filter((f: any) => typeof f === "string")
          : [];
        const id = await storage.writeEntity(name, type, safeFacts);
        if (id) persistedIds.push(id);
      } catch (err) {
        log.warn(`persistExtraction: entity write failed: ${err}`);
      }
    }

    // Persist entity relationships (v7.0)
    if (this.config.entityRelationshipsEnabled && Array.isArray(result.relationships)) {
      for (const rel of result.relationships.slice(0, 5)) {
        if (!rel.source || !rel.target || !rel.label) continue;
        try {
          // Add bidirectional relationship
          await storage.addEntityRelationship(rel.source, { target: rel.target, label: rel.label });
          await storage.addEntityRelationship(rel.target, { target: rel.source, label: `${rel.label} (reverse)` });
        } catch (err) {
          log.debug(`relationship persist failed: ${err}`);
        }
      }
    }

    // Persist entity activity (v7.0)
    if (this.config.entityActivityLogEnabled) {
      const today = new Date().toISOString().slice(0, 10);
      for (const entity of entities) {
        const name = (entity as any)?.name;
        const type = (entity as any)?.type;
        if (typeof name !== "string" || typeof type !== "string") continue;
        try {
          const normalized = normalizeEntityName(name, type);
          await storage.addEntityActivity(
            normalized,
            { date: today, note: "Mentioned in conversation" },
            this.config.entityActivityLogMaxEntries,
          );
        } catch (err) {
          log.debug(`activity persist failed: ${err}`);
        }
      }
    }

    if (profileUpdates.length > 0) {
      await storage.appendToProfile(profileUpdates);
    }

    // Persist questions
    for (const q of questions) {
      await storage.writeQuestion(q.question, q.context, q.priority);
    }

    // Persist identity reflection
    if (this.config.identityEnabled && result.identityReflection) {
      try {
        await storage.appendToIdentity(this.config.workspaceDir, result.identityReflection);
      } catch (err) {
        log.debug(`identity reflection write failed: ${err}`);
      }
    }

    // Save content-hash index after batch
    if (this.contentHashIndex) {
      await this.contentHashIndex.save().catch((err) =>
        log.warn(`content-hash index save failed: ${err}`),
      );
    }

    const dedupSuffix = dedupedCount > 0 ? ` (${dedupedCount} deduped)` : "";
    log.info(
      `persisted: ${facts.length - dedupedCount} facts${dedupSuffix}, ${entities.length} entities, ${questions.length} questions, ${profileUpdates.length} profile updates`,
    );

    // Return the persisted fact IDs for threading
    return persistedIds;
  }

  private async indexPersistedMemory(storage: StorageManager, memoryId: string): Promise<void> {
    if (!this.config.embeddingFallbackEnabled) return;
    if (!(await this.embeddingFallback.isAvailable())) return;
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) return;
    await this.embeddingFallback.indexFile(memoryId, memory.content, memory.path);
  }

  /** IDs of facts persisted in the last extraction */
  private lastPersistedIds: string[] = [];

  private async runConsolidation(): Promise<{ memoriesProcessed: number; merged: number; invalidated: number }> {
    log.info("running consolidation pass");
    let merged = 0;
    let invalidated = 0;

    // Flush access tracking buffer first
    if (this.accessTrackingBuffer.size > 0) {
      await this.flushAccessTracking();
    }

    const allMemories = await this.storage.readAllMemories();
    if (allMemories.length < 5) {
      return { memoriesProcessed: allMemories.length, merged, invalidated };
    }

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
          if (await this.storage.invalidateMemory(item.existingId)) {
            invalidated += 1;
            await this.embeddingFallback.removeFromIndex(item.existingId);
          }
          break;
        case "UPDATE":
          if (item.updatedContent) {
            await this.storage.updateMemory(item.existingId, item.updatedContent, {
              lineage: [item.existingId],
            });
            await this.indexPersistedMemory(this.storage, item.existingId);
          }
          break;
        case "MERGE":
          if (item.updatedContent && item.mergeWith) {
            await this.storage.updateMemory(item.existingId, item.updatedContent, {
              supersedes: item.mergeWith,
              lineage: [item.existingId, item.mergeWith],
            });
            await this.indexPersistedMemory(this.storage, item.existingId);
            if (await this.storage.invalidateMemory(item.mergeWith)) {
              invalidated += 1;
              merged += 1;
              await this.embeddingFallback.removeFromIndex(item.mergeWith);
            }
          }
          break;
      }
    }

    if (result.profileUpdates.length > 0) {
      await this.storage.appendToProfile(result.profileUpdates);
    }

    for (const entity of result.entityUpdates) {
      const safeFacts = Array.isArray((entity as any)?.facts)
        ? (entity as any).facts.filter((f: any) => typeof f === "string")
        : [];
      await this.storage.writeEntity(entity.name, entity.type, safeFacts);
    }

    // Merge fragmented entity files
    const entitiesMerged = await this.storage.mergeFragmentedEntities();
    if (entitiesMerged > 0) {
      log.info(`merged ${entitiesMerged} fragmented entity files`);
    }

    // Generate entity summaries (v7.0)
    if (this.config.entitySummaryEnabled) {
      try {
        const entityFiles = await this.storage.readAllEntityFiles();
        const needsSummary = entityFiles.filter(
          (e) => e.facts.length > 5 && !e.summary,
        );
        const toSummarize = needsSummary.slice(0, 5);
        let summarized = 0;
        for (const entity of toSummarize) {
          try {
            const factsText = entity.facts.slice(0, 10).join("; ");
            const prompt = `Summarize this entity in one sentence. Entity: ${entity.name} (${entity.type}). Facts: ${factsText}`;
            const response = await this.localLlm.chatCompletion(
              [
                { role: "system", content: "Respond with a single concise sentence summarizing the entity. No JSON, just plain text." },
                { role: "user", content: prompt },
              ],
              { temperature: 0.3, maxTokens: 100, operation: "entity_summary" },
            );
            if (response?.content) {
              const summary = response.content.trim().replace(/^["']|["']$/g, "");
              if (summary.length > 10 && summary.length < 500) {
                const entityFileName = normalizeEntityName(entity.name, entity.type);
                await this.storage.updateEntitySummary(entityFileName, summary);
                summarized++;
              }
            }
          } catch (err) {
            log.debug(`entity summary generation failed for ${entity.name}: ${err}`);
          }
        }
        if (summarized > 0) {
          log.info(`generated ${summarized} entity summaries`);
        }
      } catch (err) {
        log.debug(`entity summary pass failed: ${err}`);
      }
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

    // Fact archival pass (v6.0) — move old, low-importance, rarely-accessed facts to archive/
    if (this.config.factArchivalEnabled) {
      const archived = await this.runFactArchival(allMemories);
      if (archived > 0) {
        log.info(`archived ${archived} old low-importance facts`);
      }
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
    return { memoriesProcessed: allMemories.length, merged, invalidated };
  }

  /**
   * Archive old, low-importance, rarely-accessed facts (v6.0).
   * Moves eligible facts from facts/ to archive/YYYY-MM-DD/.
   * Returns the number of archived facts.
   */
  private async runFactArchival(allMemories: import("./types.js").MemoryFile[]): Promise<number> {
    const now = Date.now();
    const ageCutoffMs = this.config.factArchivalAgeDays * 24 * 60 * 60 * 1000;
    const protectedCategories = new Set(this.config.factArchivalProtectedCategories);
    let archivedCount = 0;

    for (const memory of allMemories) {
      const fm = memory.frontmatter;

      // Skip already-archived or superseded
      if (fm.status && fm.status !== "active") continue;

      // Skip protected categories
      if (protectedCategories.has(fm.category)) continue;

      // Skip corrections (always keep)
      if (fm.category === "correction") continue;

      // Check age requirement
      const createdMs = new Date(fm.created).getTime();
      if (now - createdMs < ageCutoffMs) continue;

      // Check importance (only archive low-importance facts)
      const importanceScore = fm.importance?.score ?? 0.5;
      if (importanceScore >= this.config.factArchivalMaxImportance) continue;

      // Check access count
      const accessCount = fm.accessCount ?? 0;
      if (accessCount > this.config.factArchivalMaxAccessCount) continue;

      // All criteria met — archive
      const result = await this.storage.archiveMemory(memory);
      if (result) {
        // Remove from content-hash index since it's no longer in hot search
        if (this.contentHashIndex) {
          this.contentHashIndex.remove(memory.content);
        }
        await this.embeddingFallback.removeFromIndex(memory.frontmatter.id);
        archivedCount++;
      }
    }

    // Save hash index if we removed any entries
    if (archivedCount > 0 && this.contentHashIndex) {
      await this.contentHashIndex.save().catch((err) =>
        log.warn(`content-hash index save failed during archival: ${err}`),
      );
    }

    return archivedCount;
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

  private async searchEmbeddingFallback(query: string, limit: number): Promise<QmdSearchResult[]> {
    if (!this.config.embeddingFallbackEnabled) return [];
    if (!(await this.embeddingFallback.isAvailable())) return [];
    const hits = await this.embeddingFallback.search(query, limit);
    if (hits.length === 0) return [];

    const results: QmdSearchResult[] = [];
    for (const hit of hits) {
      const fullPath = path.isAbsolute(hit.path) ? hit.path : path.join(this.config.memoryDir, hit.path);
      const memory = await this.storage.readMemoryByPath(fullPath);
      if (!memory) continue;
      results.push({
        docid: hit.id,
        path: fullPath,
        score: hit.score,
        snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
      });
    }
    return results;
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
    const namespaces = this.config.namespacesEnabled
      ? Array.from(
          new Set<string>([
            this.config.defaultNamespace,
            this.config.sharedNamespace,
            ...this.config.namespacePolicies.map((p) => p.name),
          ]),
        )
      : [this.config.defaultNamespace];
    const memories = await this.readAllMemoriesForNamespaces(namespaces);
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

    const byNamespace = new Map<string, AccessTrackingEntry[]>();
    for (const e of entries) {
      const m = memoryMap.get(e.memoryId);
      if (!m) continue;
      const ns = this.namespaceFromPath(m.path);
      const list = byNamespace.get(ns) ?? [];
      list.push(e);
      byNamespace.set(ns, list);
    }
    for (const [ns, list] of byNamespace) {
      const sm = await this.storageRouter.storageFor(ns);
      await sm.flushAccessTracking(list);
    }
    this.accessTrackingBuffer.clear();
    log.debug(`flushed ${entries.length} access tracking entries`);
  }

  /**
   * Apply recency, access count, and importance boosting to QMD search results.
   * Returns re-ranked results.
   */
  private async boostSearchResults(
    results: QmdSearchResult[],
    _recallNamespaces: string[],
    prompt?: string,
  ): Promise<QmdSearchResult[]> {
    if (results.length === 0) return results;

    const now = Date.now();
    // Only read memory files referenced in QMD results (not all 15,000+).
    const memoryByPath = new Map<string, MemoryFile>();
    await Promise.all(
      results.map(async (r) => {
        if (!r.path || memoryByPath.has(r.path)) return;
        const mem = await this.storage.readMemoryByPath(r.path);
        if (mem) memoryByPath.set(r.path, mem);
      }),
    );

    const queryIntent = this.config.intentRoutingEnabled && prompt
      ? inferIntentFromText(prompt)
      : null;

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

        // Feedback bias (v2.2): apply small user-provided up/down vote adjustments.
        if (this.config.feedbackEnabled) {
          const match = memory.path.match(/([^/]+)\.md$/);
          const memoryId = match ? match[1] : null;
          if (memoryId) {
            score += this.relevance.adjustment(memoryId);
          }
        }

        // Negative examples (v2.2): apply a small penalty for memories repeatedly marked "not useful".
        if (this.config.negativeExamplesEnabled) {
          const match = memory.path.match(/([^/]+)\.md$/);
          const memoryId = match ? match[1] : null;
          if (memoryId) {
            score -= this.negatives.penalty(memoryId, {
              perHit: this.config.negativeExamplesPenaltyPerHit,
              cap: this.config.negativeExamplesPenaltyCap,
            });
          }
        }

        if (
          queryIntent &&
          memory.frontmatter.intentGoal &&
          memory.frontmatter.intentActionType
        ) {
          const compatibility = intentCompatibilityScore(queryIntent, {
            goal: memory.frontmatter.intentGoal,
            actionType: memory.frontmatter.intentActionType,
            entityTypes: memory.frontmatter.intentEntityTypes ?? [],
          });
          score += compatibility * this.config.intentRoutingBoost;
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

  // ---------------------------------------------------------------------------
  // Feedback (v2.2)
  // ---------------------------------------------------------------------------

  async recordMemoryFeedback(memoryId: string, vote: "up" | "down", note?: string): Promise<void> {
    await this.relevance.record(memoryId, vote, note);
  }

  // Negative Examples (v2.2)
  async recordNotUsefulMemories(memoryIds: string[], note?: string): Promise<void> {
    await this.negatives.recordNotUseful(memoryIds, note);
  }

  getLastRecall(sessionKey: string): LastRecallSnapshot | null {
    return this.lastRecall.get(sessionKey);
  }

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

  private namespaceFromPath(p: string): string {
    if (!this.config.namespacesEnabled) return this.config.defaultNamespace;
    const m = p.match(/[\\/]+namespaces[\\/]+([^\\/]+)[\\/]+/);
    return m && m[1] ? m[1] : this.config.defaultNamespace;
  }

  private async readAllMemoriesForNamespaces(namespaces: string[]): Promise<MemoryFile[]> {
    const uniq = Array.from(new Set(namespaces.filter(Boolean)));
    const lists = await Promise.all(
      uniq.map(async (ns) => {
        const sm = await this.storageRouter.storageFor(ns);
        return sm.readAllMemories();
      }),
    );
    return lists.flat();
  }
}
