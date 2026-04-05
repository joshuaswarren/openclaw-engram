import { stat } from "node:fs/promises";
import { AccessIdempotencyStore, hashAccessIdempotencyPayload } from "./access-idempotency.js";
import {
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  validateExplicitCaptureInput,
  type ExplicitCaptureInput,
  type ValidExplicitCapture,
} from "./explicit-capture.js";
import { log } from "./logger.js";
import {
  buildQualityScore,
  buildProposedActions,
  groupActionsByStatus,
  listMemoryGovernanceRuns,
  readMemoryGovernanceRunArtifact,
  runMemoryGovernance,
} from "./maintenance/memory-governance.js";
import {
  normalizeProjectionPreview,
  normalizeProjectionTags,
} from "./memory-projection-format.js";
import {
  inferMemoryStatus,
  toMemoryPathRel,
} from "./memory-lifecycle-ledger-utils.js";
import { getMemoryProjectionPath } from "./memory-projection-store.js";
import { canReadNamespace, canWriteNamespace, resolvePrincipal } from "./namespaces/principal.js";
import type { LastRecallSnapshot } from "./recall-state.js";
import type {
  GraphRecallSnapshot,
  IntentDebugSnapshot,
  Orchestrator,
  RecallInvocationOptions,
} from "./orchestrator.js";
import { parseEntityFile } from "./storage.js";
import {
  getTrustZoneStoreStatus,
  isTrustZoneName,
  listTrustZoneRecords,
  promoteTrustZoneRecord,
  scoreTrustZoneProvenance,
  seedTrustZoneDemoDataset,
  summarizeTrustZonePromotionReadiness,
  type TrustZoneDemoSeedResult,
  type TrustZoneName,
  type TrustZonePromotionResult,
  type TrustZoneProvenanceScore,
  type TrustZoneRecord,
  type TrustZoneRecordKind,
  type TrustZoneSourceClass,
  type TrustZoneStoreStatus,
} from "./trust-zones.js";
import type {
  EntityFile,
  MemoryFile,
  MemoryLifecycleEvent,
  MemoryStatus,
  RecallPlanMode,
} from "./types.js";

export class EngramAccessInputError extends Error {}

function normalizeTrustZoneInputError(error: unknown): EngramAccessInputError | null {
  const message = error instanceof Error ? error.message : null;
  if (!message) {
    return null;
  }
  if (
    /^sourceRecordId must /.test(message) ||
    /^promotionReason must /.test(message) ||
    /^recordedAt must /.test(message) ||
    /^trust zone promotion requires /.test(message) ||
    /^source trust-zone record not found: /.test(message) ||
    /^trust-zone promotion denied: /.test(message) ||
    /^trust zone demo seed requires /.test(message) ||
    /^unsupported trust-zone demo scenario: /.test(message)
  ) {
    return new EngramAccessInputError(message);
  }
  return null;
}

export const ENGRAM_ACCESS_WRITE_SCHEMA_VERSION = 1;

export interface EngramAccessHealthResponse {
  ok: true;
  memoryDir: string;
  namespacesEnabled: boolean;
  defaultNamespace: string;
  searchBackend: string;
  qmdEnabled: boolean;
  nativeKnowledgeEnabled: boolean;
  projectionAvailable: boolean;
}

export interface EngramAccessRecallRequest {
  query: string;
  sessionKey?: string;
  namespace?: string;
  topK?: number;
  mode?: RecallPlanMode | "auto";
  includeDebug?: boolean;
}

export interface EngramAccessRecallResponse {
  query: string;
  sessionKey?: string;
  namespace: string;
  context: string;
  count: number;
  memoryIds: string[];
  results: EngramAccessMemorySummary[];
  recordedAt?: string;
  traceId?: string;
  plannerMode?: RecallPlanMode;
  fallbackUsed: boolean;
  sourcesUsed: string[];
  budgetsApplied?: LastRecallSnapshot["budgetsApplied"];
  latencyMs?: number;
  debug?: {
    snapshot?: LastRecallSnapshot;
    intent?: IntentDebugSnapshot | null;
    graph?: GraphRecallSnapshot | null;
  };
}

export interface EngramAccessRecallExplainRequest {
  sessionKey?: string;
  namespace?: string;
}

export interface EngramAccessRecallExplainResponse {
  found: boolean;
  snapshot?: LastRecallSnapshot;
  intent?: IntentDebugSnapshot | null;
  graph?: GraphRecallSnapshot | null;
}

export interface EngramAccessDaySummaryRequest {
  memories?: string;
  sessionKey?: string;
  namespace?: string;
}

export interface EngramAccessMemoryRecord {
  id: string;
  path: string;
  category: string;
  status?: string;
  created?: string;
  updated?: string;
  content: string;
  frontmatter: MemoryFile["frontmatter"];
}

export interface EngramAccessMemorySummary {
  id: string;
  path: string;
  category: string;
  status: string;
  created?: string;
  updated?: string;
  tags: string[];
  entityRef?: string;
  preview: string;
}

export interface EngramAccessMemoryBrowseRequest {
  query?: string;
  status?: string;
  category?: string;
  namespace?: string;
  sort?: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
  limit?: number;
  offset?: number;
}

export interface EngramAccessMemoryBrowseResponse {
  namespace: string;
  sort: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
  total: number;
  count: number;
  limit: number;
  offset: number;
  memories: EngramAccessMemorySummary[];
}

export interface EngramAccessMemoryResponse {
  found: boolean;
  namespace: string;
  memory?: EngramAccessMemoryRecord;
}

export interface EngramAccessTimelineResponse {
  found: boolean;
  namespace: string;
  count: number;
  timeline: MemoryLifecycleEvent[];
}

export interface EngramAccessEntitySummary {
  name: string;
  type: string;
  updated: string;
  summary?: string;
  aliases: string[];
}

export interface EngramAccessEntityListResponse {
  namespace: string;
  total: number;
  count: number;
  limit: number;
  offset: number;
  entities: EngramAccessEntitySummary[];
}

export interface EngramAccessEntityResponse {
  found: boolean;
  namespace: string;
  entity?: EntityFile;
}

export interface EngramAccessReviewQueueResponse {
  found: boolean;
  namespace?: string;
  runId?: string;
  summary?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["summary"];
  metrics?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["metrics"];
  qualityScore?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["qualityScore"];
  reviewQueue?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["reviewQueue"];
  appliedActions?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["appliedActions"];
  transitionReport?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["transitionReport"];
  report?: string;
}

export interface EngramAccessMaintenanceResponse {
  namespace: string;
  health: EngramAccessHealthResponse;
  latestGovernanceRun: EngramAccessReviewQueueResponse;
}

export interface EngramAccessTrustZoneStatusResponse {
  namespace: string;
  status: TrustZoneStoreStatus;
}

export interface EngramAccessTrustZoneRecordSummary {
  recordId: string;
  filePath: string;
  zone: TrustZoneName;
  recordedAt: string;
  kind: TrustZoneRecordKind;
  summary: string;
  sourceClass: TrustZoneSourceClass;
  sessionKey?: string;
  sourceId?: string;
  evidenceHashPresent: boolean;
  anchored: boolean;
  entityRefs: string[];
  tags: string[];
  metadata?: Record<string, string>;
  trustScore?: TrustZoneProvenanceScore;
  nextPromotionTarget?: TrustZoneName;
  nextPromotionAllowed: boolean;
  nextPromotionReasons: string[];
  corroborationCount?: number;
  corroborationSourceClasses?: TrustZoneSourceClass[];
}

export interface EngramAccessTrustZoneBrowseRequest {
  query?: string;
  zone?: TrustZoneName;
  kind?: TrustZoneRecordKind;
  sourceClass?: TrustZoneSourceClass;
  namespace?: string;
  limit?: number;
  offset?: number;
}

export interface EngramAccessTrustZoneBrowseResponse {
  namespace: string;
  total: number;
  count: number;
  limit: number;
  offset: number;
  records: EngramAccessTrustZoneRecordSummary[];
}

export interface EngramAccessTrustZonePromoteRequest {
  recordId: string;
  targetZone: TrustZoneName;
  promotionReason: string;
  recordedAt?: string;
  summary?: string;
  dryRun?: boolean;
  namespace?: string;
  authenticatedPrincipal?: string;
}

export interface EngramAccessTrustZonePromoteResponse extends TrustZonePromotionResult {
  namespace: string;
  dryRun: boolean;
}

export interface EngramAccessTrustZoneDemoSeedRequest {
  scenario?: string;
  recordedAt?: string;
  dryRun?: boolean;
  namespace?: string;
  authenticatedPrincipal?: string;
}

export interface EngramAccessTrustZoneDemoSeedResponse extends TrustZoneDemoSeedResult {
  namespace: string;
}

export interface EngramAccessQualityResponse {
  namespace: string;
  totalMemories: number;
  statusCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  confidenceTierCounts: Record<string, number>;
  ageBucketCounts: Record<string, number>;
  archivePressure: {
    pendingReview: number;
    quarantined: number;
    archived: number;
    staleActive: number;
    lowConfidenceActive: number;
  };
  latestGovernanceRun: {
    found: boolean;
    runId?: string;
    qualityScore?: EngramAccessReviewQueueResponse["qualityScore"];
    reviewQueueCount: number;
  };
}

async function buildProjectedGovernanceProposedActions(
  storage: Awaited<ReturnType<Orchestrator["getStorage"]>>,
  projected: NonNullable<Awaited<ReturnType<Awaited<ReturnType<Orchestrator["getStorage"]>>["getProjectedGovernanceRecord"]>>>,
): Promise<Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["appliedActions"]> {
  const reviewQueue = projected.reviewQueueRows.map((row) => ({
    entryId: row.entryId,
    memoryId: row.memoryId,
    path: row.path,
    reasonCode: row.reasonCode,
    severity: row.severity,
    suggestedAction: row.suggestedAction,
    suggestedStatus: row.suggestedStatus,
    relatedMemoryIds: row.relatedMemoryIds,
  })) as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["reviewQueue"];
  const memories = (await Promise.all(projected.reviewQueueRows.map((row) => storage.getMemoryById(row.memoryId))))
    .filter((memory): memory is MemoryFile => Boolean(memory));
  return buildProposedActions(reviewQueue, memories);
}

function hasGroupedGovernanceActions(
  grouped?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["transitionReport"]["proposed"],
): boolean {
  if (!grouped) return false;
  return Object.values(grouped).some((actions) => Array.isArray(actions) && actions.length > 0);
}

export interface EngramAccessReviewDispositionRequest {
  memoryId: string;
  status: MemoryStatus | "archived";
  reasonCode: string;
  namespace?: string;
  /**
   * Trusted transport-bound principal. This must never come from untrusted client payloads.
   * When present, write authorization is evaluated against this principal instead of sessionKey.
   */
  authenticatedPrincipal?: string;
}

export interface EngramAccessReviewDispositionResponse {
  ok: boolean;
  namespace: string;
  memoryId: string;
  status: MemoryStatus | "archived";
  previousStatus: MemoryStatus;
  currentPath?: string;
}

export interface EngramAccessWriteEnvelope {
  schemaVersion?: number;
  idempotencyKey?: string;
  dryRun?: boolean;
  sessionKey?: string;
  /**
   * Trusted transport-bound principal. This must never come from untrusted client payloads.
   * When present, write authorization is evaluated against this principal instead of sessionKey.
   */
  authenticatedPrincipal?: string;
}

export interface EngramAccessMemoryStoreRequest extends EngramAccessWriteEnvelope, ExplicitCaptureInput {}

export interface EngramAccessSuggestionSubmitRequest extends EngramAccessWriteEnvelope, ExplicitCaptureInput {}

export interface EngramAccessWriteResponse {
  schemaVersion: 1;
  operation: "memory_store" | "suggestion_submit";
  namespace: string;
  dryRun: boolean;
  accepted: boolean;
  queued: boolean;
  status: "validated" | "stored" | "duplicate" | "queued_for_review";
  memoryId?: string;
  duplicateOf?: string;
  idempotencyKey?: string;
  idempotencyReplay?: boolean;
}

export interface EngramAccessObserveRequest {
  sessionKey: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  namespace?: string;
  authenticatedPrincipal?: string;
  skipExtraction?: boolean;
}

export interface EngramAccessObserveResponse {
  accepted: number;
  sessionKey: string;
  namespace: string;
  lcmArchived: boolean;
  extractionQueued: boolean;
}

export interface EngramAccessLcmSearchRequest {
  query: string;
  sessionKey?: string;
  namespace?: string;
  limit?: number;
  authenticatedPrincipal?: string;
}

export interface EngramAccessLcmSearchResponse {
  query: string;
  namespace: string;
  results: Array<{ sessionId: string; content: string; turnIndex?: number }>;
  count: number;
  lcmEnabled: boolean;
}

export interface EngramAccessLcmStatusResponse {
  enabled: boolean;
  archiveAvailable: boolean;
  stats?: { totalTurns?: number };
}

type EngramAccessIdempotencyStatus = "miss" | "replay" | "conflict";

function normalizePagination(limit?: number, offset?: number): { limit: number; offset: number } {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit ?? 50))) : 50;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset ?? 0)) : 0;
  return { limit: normalizedLimit, offset: normalizedOffset };
}

function normalizeBrowseSort(
  sort?: EngramAccessMemoryBrowseRequest["sort"],
): NonNullable<EngramAccessMemoryBrowseRequest["sort"]> {
  switch (sort) {
    case "updated_asc":
    case "created_desc":
    case "created_asc":
      return sort;
    case "updated_desc":
    default:
      return "updated_desc";
  }
}

function bucketMemoryAge(referenceIso: string | undefined, nowMs: number): string {
  const referenceMs = referenceIso ? Date.parse(referenceIso) : Number.NaN;
  if (!Number.isFinite(referenceMs)) return "unknown";
  const ageDays = Math.floor((nowMs - referenceMs) / 86_400_000);
  if (ageDays <= 7) return "0_7_days";
  if (ageDays <= 30) return "8_30_days";
  if (ageDays <= 90) return "31_90_days";
  return "91_plus_days";
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function summarizeTrustZoneRecord(
  record: TrustZoneRecord,
  filePath: string,
  allRecords: TrustZoneRecord[],
  poisoningDefenseEnabled: boolean,
  trustZonesEnabled: boolean,
  promotionEnabled: boolean,
): EngramAccessTrustZoneRecordSummary {
  const trustScore = poisoningDefenseEnabled ? scoreTrustZoneProvenance(record) : undefined;
  const readiness = summarizeTrustZonePromotionReadiness({
    record,
    allRecords,
    poisoningDefenseEnabled,
  });
  const promotionReasons = [...readiness.reasons];
  const promotionAllowed = readiness.allowed && trustZonesEnabled === true && promotionEnabled === true;
  if (trustZonesEnabled !== true) {
    promotionReasons.push("trust zone promotion requires trustZonesEnabled=true");
  }
  if (promotionEnabled !== true) {
    promotionReasons.push("trust zone promotion requires quarantinePromotionEnabled=true");
  }
  return {
    recordId: record.recordId,
    filePath,
    zone: record.zone,
    recordedAt: record.recordedAt,
    kind: record.kind,
    summary: record.summary,
    sourceClass: record.provenance.sourceClass,
    sessionKey: record.provenance.sessionKey,
    sourceId: record.provenance.sourceId,
    evidenceHashPresent: typeof record.provenance.evidenceHash === "string",
    anchored: Boolean(record.provenance.sourceId && record.provenance.evidenceHash),
    entityRefs: [...(record.entityRefs ?? [])],
    tags: [...(record.tags ?? [])],
    metadata: record.metadata,
    trustScore,
    nextPromotionTarget: readiness.nextTargetZone,
    nextPromotionAllowed: promotionAllowed,
    nextPromotionReasons: promotionReasons,
    corroborationCount: readiness.requiresCorroboration ? readiness.corroborationCount : undefined,
    corroborationSourceClasses: readiness.requiresCorroboration ? readiness.corroborationSourceClasses : undefined,
  };
}

function compareBrowseMemory(
  sort: NonNullable<EngramAccessMemoryBrowseRequest["sort"]>,
  left: MemoryFile,
  right: MemoryFile,
): number {
  const leftUpdated = left.frontmatter.updated ?? left.frontmatter.created ?? "";
  const rightUpdated = right.frontmatter.updated ?? right.frontmatter.created ?? "";
  const leftCreated = left.frontmatter.created ?? "";
  const rightCreated = right.frontmatter.created ?? "";

  switch (sort) {
    case "updated_asc":
      return (
        leftUpdated.localeCompare(rightUpdated) ||
        leftCreated.localeCompare(rightCreated) ||
        left.frontmatter.id.localeCompare(right.frontmatter.id)
      );
    case "created_desc":
      return (
        rightCreated.localeCompare(leftCreated) ||
        rightUpdated.localeCompare(leftUpdated) ||
        left.frontmatter.id.localeCompare(right.frontmatter.id)
      );
    case "created_asc":
      return (
        leftCreated.localeCompare(rightCreated) ||
        leftUpdated.localeCompare(rightUpdated) ||
        left.frontmatter.id.localeCompare(right.frontmatter.id)
      );
    case "updated_desc":
    default:
      return (
        rightUpdated.localeCompare(leftUpdated) ||
        rightCreated.localeCompare(leftCreated) ||
        left.frontmatter.id.localeCompare(right.frontmatter.id)
      );
  }
}

export class EngramAccessService {
  private readonly idempotency: AccessIdempotencyStore;
  private readonly idempotencyLocks = new Map<string, Promise<void>>();

  constructor(private readonly orchestrator: Orchestrator) {
    this.idempotency = new AccessIdempotencyStore(orchestrator.config.memoryDir);
  }

  private resolveNamespace(namespace?: string): string {
    const requested = namespace?.trim();
    if (!requested) return this.orchestrator.config.defaultNamespace;
    if (!this.orchestrator.config.namespacesEnabled && requested !== this.orchestrator.config.defaultNamespace) {
      throw new EngramAccessInputError(`unsupported namespace: ${requested}`);
    }
    return requested;
  }

  private normalizeRecallMode(mode?: RecallPlanMode | "auto"): RecallPlanMode | undefined {
    if (!mode || mode === "auto") return undefined;
    if (mode === "no_recall" || mode === "minimal" || mode === "full" || mode === "graph_mode") {
      return mode;
    }
    throw new EngramAccessInputError(`unsupported recall mode: ${mode}`);
  }

  private resolveRecallNamespace(namespace: string | undefined, sessionKey: string | undefined): string | undefined {
    const requested = namespace?.trim();
    if (!requested) return undefined;
    const resolved = this.resolveNamespace(requested);
    const principal = resolvePrincipal(sessionKey, this.orchestrator.config);
    if (!canReadNamespace(principal, resolved, this.orchestrator.config)) {
      throw new EngramAccessInputError(`namespace override is not readable: ${resolved}`);
    }
    return resolved;
  }

  private resolveWritePrincipal(sessionKey: string | undefined, authenticatedPrincipal?: string): string {
    const trusted = authenticatedPrincipal?.trim();
    if (trusted) return trusted;
    return resolvePrincipal(sessionKey, this.orchestrator.config);
  }

  private resolveWritableNamespace(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string,
  ): string {
    const resolved = this.resolveNamespace(namespace);
    const principal = this.resolveWritePrincipal(sessionKey, authenticatedPrincipal);
    if (!canWriteNamespace(principal, resolved, this.orchestrator.config)) {
      throw new EngramAccessInputError(`namespace is not writable: ${resolved}`);
    }
    return resolved;
  }

  private resolveReadableNamespace(namespace: string | undefined, principal?: string): string {
    const resolved = this.resolveNamespace(namespace);
    if (principal && !canReadNamespace(principal, resolved, this.orchestrator.config)) {
      throw new EngramAccessInputError(`namespace is not readable: ${resolved}`);
    }
    return resolved;
  }

  private async buildRecallDebug(
    snapshot: LastRecallSnapshot | null,
    namespace: string,
    includeDebug: boolean,
    sessionKey?: string,
  ): Promise<EngramAccessRecallResponse["debug"] | undefined> {
    if (!includeDebug) return undefined;
    if (!sessionKey?.trim()) return undefined;
    const [intent, graph] = await Promise.all([
      this.orchestrator.getLastIntentSnapshot(namespace),
      this.orchestrator.getLastGraphRecallSnapshot(namespace),
    ]);
    return snapshot || intent || graph
      ? {
        snapshot: snapshot ?? undefined,
        intent,
        graph,
      }
      : undefined;
  }

  private async serializeRecallResults(snapshot: LastRecallSnapshot | null): Promise<EngramAccessMemorySummary[]> {
    if (!snapshot) return [];
    const namespace = snapshot.namespace ? this.resolveNamespace(snapshot.namespace) : this.orchestrator.config.defaultNamespace;
    const storage = await this.orchestrator.getStorage(namespace);
    const storageDir = storage.dir;
    const results: EngramAccessMemorySummary[] = [];
    const seen = new Set<string>();

    for (const memoryPath of snapshot.resultPaths ?? []) {
      if (!memoryPath || seen.has(memoryPath)) continue;
      const memory = await storage.readMemoryByPath(memoryPath);
      if (!memory) continue;
      seen.add(memoryPath);
      results.push(this.serializeMemorySummary(memory, storageDir));
    }

    if (results.length > 0) return results;

    for (const memoryId of snapshot.memoryIds) {
      const memory = await storage.getMemoryById(memoryId);
      if (!memory || seen.has(memory.path)) continue;
      seen.add(memory.path);
      results.push(this.serializeMemorySummary(memory, storageDir));
    }
    return results;
  }

  private async handleIdempotentWrite<T extends EngramAccessWriteResponse>(options: {
    operation: T["operation"];
    idempotencyKey?: string;
    requestFingerprint: unknown;
    skip?: boolean;
    execute: () => Promise<T>;
  }): Promise<T> {
    if (options.skip === true) {
      return options.execute();
    }
    const key = options.idempotencyKey?.trim();
    if (!key) {
      return options.execute();
    }
    return this.withIdempotencyLock(key, async () => {
      return this.idempotency.withKeyLock(key, async () => {
        const requestHash = hashAccessIdempotencyPayload({
          operation: options.operation,
          request: options.requestFingerprint,
        });
        const existing = await this.idempotency.get(key, requestHash);
        if (existing.conflict) {
          throw new EngramAccessInputError(`idempotencyKey reuse conflict: ${key}`);
        }
        if (existing.response) {
          return {
            ...(existing.response as T),
            idempotencyReplay: true,
          };
        }
        const response = await options.execute();
        await this.idempotency.put(key, requestHash, response);
        return response;
      });
    });
  }

  private async peekIdempotentWrite(options: {
    operation: EngramAccessWriteResponse["operation"];
    idempotencyKey?: string;
    requestFingerprint: unknown;
    skip?: boolean;
  }): Promise<EngramAccessIdempotencyStatus> {
    if (options.skip === true) {
      return "miss";
    }
    const key = options.idempotencyKey?.trim();
    if (!key) {
      return "miss";
    }
    return this.withIdempotencyLock(key, async () => {
      return this.idempotency.withKeyLock(key, async () => {
        const requestHash = hashAccessIdempotencyPayload({
          operation: options.operation,
          request: options.requestFingerprint,
        });
        const existing = await this.idempotency.get(key, requestHash);
        if (existing.conflict) {
          return "conflict";
        }
        return existing.response ? "replay" : "miss";
      });
    });
  }

  private async withIdempotencyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.idempotencyLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current, () => current);
    this.idempotencyLocks.set(key, queued);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.idempotencyLocks.get(key) === queued) {
        this.idempotencyLocks.delete(key);
      }
    }
  }

  async health(namespace?: string): Promise<EngramAccessHealthResponse> {
    const resolvedNamespace = this.resolveNamespace(namespace);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    let projectionAvailable = false;
    try {
      await stat(getMemoryProjectionPath(storage.dir));
      projectionAvailable = true;
    } catch {
      projectionAvailable = false;
    }

    return {
      ok: true,
      memoryDir: storage.dir,
      namespacesEnabled: this.orchestrator.config.namespacesEnabled === true,
      defaultNamespace: this.orchestrator.config.defaultNamespace,
      searchBackend: this.orchestrator.config.searchBackend ?? "qmd",
      qmdEnabled: this.orchestrator.config.qmdEnabled === true,
      nativeKnowledgeEnabled: this.orchestrator.config.nativeKnowledge?.enabled === true,
      projectionAvailable,
    };
  }

  async daySummary(
    request: EngramAccessDaySummaryRequest,
  ): Promise<import("./types.js").DaySummaryResult | null> {
    if (!this.orchestrator.config.daySummaryEnabled) {
      throw new EngramAccessInputError("day summary is disabled");
    }

    const memories = (request.memories ?? "").trim();
    const namespace = this.resolveRecallNamespace(request.namespace, request.sessionKey);

    if (memories.length === 0) {
      // Auto-gather today's facts from the resolved namespace
      return this.orchestrator.generateDaySummaryAuto(namespace);
    }
    return this.orchestrator.generateDaySummary(memories);
  }

  async recall(request: EngramAccessRecallRequest): Promise<EngramAccessRecallResponse> {
    const query = request.query.trim();
    if (query.length === 0) {
      throw new EngramAccessInputError("query is required");
    }
    const namespaceOverride = this.resolveRecallNamespace(request.namespace, request.sessionKey);
    const namespace = namespaceOverride ?? this.orchestrator.config.defaultNamespace;
    const mode = this.normalizeRecallMode(request.mode);
    const topK = Number.isFinite(request.topK) ? Math.max(0, Math.floor(request.topK ?? 0)) : undefined;
    const recallOptions: RecallInvocationOptions = {
      namespace: namespaceOverride,
      topK,
      mode,
    };
    const startedAt = Date.now();
    const context = await this.orchestrator.recall(query, request.sessionKey, recallOptions);
    const snapshot = request.sessionKey
      ? this.orchestrator.lastRecall.get(request.sessionKey)
      : null;
    const effectiveNamespace = snapshot?.namespace
      ? this.resolveNamespace(snapshot.namespace)
      : namespace;
    const results = await this.serializeRecallResults(snapshot);
    const debug = await this.buildRecallDebug(
      snapshot,
      effectiveNamespace,
      request.includeDebug === true,
      request.sessionKey,
    );

    return {
      query,
      sessionKey: request.sessionKey,
      namespace: effectiveNamespace,
      context,
      count: snapshot?.memoryIds.length ?? results.length,
      memoryIds: snapshot?.memoryIds ?? [],
      results,
      recordedAt: snapshot?.recordedAt,
      traceId: snapshot?.traceId,
      plannerMode: snapshot?.plannerMode ?? mode,
      fallbackUsed: snapshot?.fallbackUsed ?? false,
      sourcesUsed: snapshot?.sourcesUsed ?? [],
      budgetsApplied: snapshot?.budgetsApplied,
      latencyMs: snapshot?.latencyMs ?? (Date.now() - startedAt),
      debug,
    };
  }

  async recallExplain(
    request: EngramAccessRecallExplainRequest = {},
  ): Promise<EngramAccessRecallExplainResponse> {
    const requestedNamespace = request.namespace?.trim()
      ? this.resolveNamespace(request.namespace)
      : undefined;
    if (requestedNamespace) {
      const principal = resolvePrincipal(request.sessionKey, this.orchestrator.config);
      if (!canReadNamespace(principal, requestedNamespace, this.orchestrator.config)) {
        return { found: false };
      }
    }
    const snapshot = request.sessionKey
      ? (() => {
        const candidate = this.orchestrator.lastRecall.get(request.sessionKey);
        if (!candidate) return null;
        if (!requestedNamespace) return candidate;
        return candidate.namespace === requestedNamespace ? candidate : null;
      })()
      : (() => {
        const candidate = this.orchestrator.lastRecall.getMostRecent();
        if (!candidate) return null;
        if (!requestedNamespace) return candidate;
        return candidate.namespace === requestedNamespace ? candidate : null;
      })();
    const namespace = requestedNamespace ?? snapshot?.namespace ?? this.orchestrator.config.defaultNamespace;
    const [intent, graph] = await Promise.all([
      this.orchestrator.getLastIntentSnapshot(namespace),
      this.orchestrator.getLastGraphRecallSnapshot(namespace),
    ]);
    if (!snapshot && !intent && !graph) return { found: false };
    return { found: true, snapshot: snapshot ?? undefined, intent, graph };
  }

  async memoryStore(request: EngramAccessMemoryStoreRequest): Promise<EngramAccessWriteResponse> {
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    const execute = async (): Promise<EngramAccessWriteResponse> => {
      const candidate = this.validateWriteCandidate(request, namespace);
      if (request.dryRun === true) {
        return {
          schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
          operation: "memory_store",
          namespace,
          dryRun: true,
          accepted: true,
          queued: false,
          status: "validated",
          idempotencyKey: request.idempotencyKey?.trim() || undefined,
        };
      }
      const result = await persistExplicitCapture(this.orchestrator, candidate, "memory_store");
      const response: EngramAccessWriteResponse = {
        schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
        operation: "memory_store",
        namespace,
        dryRun: false,
        accepted: true,
        queued: false,
        status: result.duplicateOf ? "duplicate" : "stored",
        memoryId: result.id,
        duplicateOf: result.duplicateOf,
        idempotencyKey: request.idempotencyKey?.trim() || undefined,
      };
      log.info(
        `access-write op=memory_store namespace=${namespace} dryRun=false status=${response.status} memoryId=${response.memoryId ?? "-"} idempotency=${response.idempotencyKey ? "yes" : "no"}`,
      );
      return response;
    };
    return this.handleIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: {
        schemaVersion,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        namespace,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
      },
      skip: request.dryRun === true,
      execute,
    });
  }

  async peekMemoryStoreIdempotency(request: EngramAccessMemoryStoreRequest): Promise<EngramAccessIdempotencyStatus> {
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    return this.peekIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: {
        schemaVersion,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        namespace,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
      },
      skip: request.dryRun === true,
    });
  }

  async suggestionSubmit(request: EngramAccessSuggestionSubmitRequest): Promise<EngramAccessWriteResponse> {
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    const execute = async (): Promise<EngramAccessWriteResponse> => {
      const candidate = this.validateWriteCandidate(request, namespace);
      if (request.dryRun === true) {
        return {
          schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
          operation: "suggestion_submit",
          namespace,
          dryRun: true,
          accepted: true,
          queued: true,
          status: "validated",
          idempotencyKey: request.idempotencyKey?.trim() || undefined,
        };
      }
      const result = await queueExplicitCaptureForReview(
        this.orchestrator,
        candidate,
        "suggestion_submit",
        new Error(request.sourceReason?.trim() || "submitted via engram suggestion_submit"),
      );
      const response: EngramAccessWriteResponse = {
        schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
        operation: "suggestion_submit",
        namespace,
        dryRun: false,
        accepted: true,
        queued: true,
        status: "queued_for_review",
        memoryId: result.id,
        duplicateOf: result.duplicateOf,
        idempotencyKey: request.idempotencyKey?.trim() || undefined,
      };
      log.info(
        `access-write op=suggestion_submit namespace=${namespace} dryRun=false status=${response.status} memoryId=${response.memoryId ?? "-"} idempotency=${response.idempotencyKey ? "yes" : "no"}`,
      );
      return response;
    };
    return this.handleIdempotentWrite({
      operation: "suggestion_submit",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: {
        schemaVersion,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        namespace,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
      },
      skip: request.dryRun === true,
      execute,
    });
  }

  async peekSuggestionSubmitIdempotency(
    request: EngramAccessSuggestionSubmitRequest,
  ): Promise<EngramAccessIdempotencyStatus> {
    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    return this.peekIdempotentWrite({
      operation: "suggestion_submit",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: {
        schemaVersion,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        namespace,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
      },
      skip: request.dryRun === true,
    });
  }

  private validateWriteCandidate(
    request: EngramAccessMemoryStoreRequest | EngramAccessSuggestionSubmitRequest,
    namespace: string,
  ): ValidExplicitCapture {
    try {
      return validateExplicitCaptureInput(
        {
          ...request,
          namespace,
        },
        "legacy_tool",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EngramAccessInputError(message);
    }
  }

  async memoryGet(memoryId: string, namespace?: string, principal?: string): Promise<EngramAccessMemoryResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) {
      return { found: false, namespace: resolvedNamespace };
    }
    return {
      found: true,
      namespace: resolvedNamespace,
      memory: this.serializeMemory(memory),
    };
  }

  async memoryBrowse(
    request: EngramAccessMemoryBrowseRequest = {},
  ): Promise<EngramAccessMemoryBrowseResponse> {
    const storage = await this.orchestrator.getStorage(request.namespace);
    const resolvedNamespace = request.namespace?.trim() || this.orchestrator.config.defaultNamespace;
    const { limit, offset } = normalizePagination(request.limit, request.offset);
    const sort = normalizeBrowseSort(request.sort);
    const query = request.query?.trim().toLowerCase() ?? "";
    const statusFilter = request.status?.trim().toLowerCase();
    const categoryFilter = request.category?.trim().toLowerCase();

    const projected = await storage.browseProjectedMemories({
      query,
      status: statusFilter,
      category: categoryFilter,
      sort,
      limit,
      offset,
    });
    if (projected) {
      return {
        namespace: resolvedNamespace,
        sort,
        total: projected.total,
        count: projected.memories.length,
        limit,
        offset,
        memories: projected.memories.map((row) => ({ ...row })),
      };
    }

    let memories = [...await storage.readAllMemories(), ...await storage.readArchivedMemories()];
    memories = memories.filter((memory) => {
      const status = inferMemoryStatus(memory.frontmatter, toMemoryPathRel(storage.dir, memory.path)).toLowerCase();
      if (statusFilter && status !== statusFilter) return false;
      if (categoryFilter && memory.frontmatter.category.toLowerCase() !== categoryFilter) return false;
      if (!query) return true;
      const haystack = [
        memory.frontmatter.id,
        memory.path,
        memory.content,
        memory.frontmatter.entityRef ?? "",
        ...memory.frontmatter.tags,
      ].join("\n").toLowerCase();
      return haystack.includes(query);
    });

    memories.sort((left, right) => compareBrowseMemory(sort, left, right));

    const page = memories
      .slice(offset, offset + limit)
      .map((memory) => this.serializeMemorySummary(memory, storage.dir));
    return {
      namespace: resolvedNamespace,
      sort,
      total: memories.length,
      count: page.length,
      limit,
      offset,
      memories: page,
    };
  }

  async memoryTimeline(
    memoryId: string,
    namespace?: string,
    limit: number = 200,
    principal?: string,
  ): Promise<EngramAccessTimelineResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const timeline = await storage.getMemoryTimeline(memoryId, limit);
    return {
      found: timeline.length > 0,
      namespace: resolvedNamespace,
      count: timeline.length,
      timeline,
    };
  }

  async entityList(options: {
    namespace?: string;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<EngramAccessEntityListResponse> {
    const storage = await this.orchestrator.getStorage(options.namespace);
    const resolvedNamespace = options.namespace?.trim() || this.orchestrator.config.defaultNamespace;
    const { limit, offset } = normalizePagination(options.limit, options.offset);
    const query = options.query?.trim().toLowerCase() ?? "";

    const names = await storage.listEntityNames();
    const entities: EngramAccessEntitySummary[] = [];
    for (const name of names) {
      const raw = await storage.readEntity(name);
      if (!raw) continue;
      const entity = parseEntityFile(raw);
      if (query) {
        const haystack = [
          entity.name,
          entity.type,
          entity.summary ?? "",
          ...entity.aliases,
          ...entity.facts,
        ].join("\n").toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      entities.push({
        name: entity.name,
        type: entity.type,
        updated: entity.updated,
        summary: entity.summary,
        aliases: entity.aliases,
      });
    }

    entities.sort((left, right) => left.name.localeCompare(right.name));
    const page = entities.slice(offset, offset + limit);
    return {
      namespace: resolvedNamespace,
      total: entities.length,
      count: page.length,
      limit,
      offset,
      entities: page,
    };
  }

  async entityGet(name: string, namespace?: string): Promise<EngramAccessEntityResponse> {
    const storage = await this.orchestrator.getStorage(namespace);
    const resolvedNamespace = namespace?.trim() || this.orchestrator.config.defaultNamespace;
    const raw = await storage.readEntity(name);
    if (!raw) return { found: false, namespace: resolvedNamespace };
    return {
      found: true,
      namespace: resolvedNamespace,
      entity: parseEntityFile(raw),
    };
  }

  async reviewQueue(runId?: string, namespace?: string, principal?: string): Promise<EngramAccessReviewQueueResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const projected = await storage.getProjectedGovernanceRecord();
    if (projected && (!runId || projected.runId === runId.trim())) {
      const projectedAppliedActions = projected.appliedActionRows.map((row) => ({
        action: row.action,
        memoryId: row.memoryId,
        reasonCode: row.reasonCode,
        beforeStatus: row.beforeStatus,
        afterStatus: row.afterStatus,
        originalPath: row.originalPath,
        currentPath: row.currentPath,
      })) as Awaited<
        ReturnType<typeof readMemoryGovernanceRunArtifact>
      >["appliedActions"];
      const projectedProposedActions = await buildProjectedGovernanceProposedActions(storage, projected);
      const projectedArtifact = await (async () => {
        try {
          return await readMemoryGovernanceRunArtifact(storage.dir, projected.runId);
        } catch {
          return null;
        }
      })();
      const metrics = projected.metrics as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["metrics"];
      const fallbackTransitionReport = {
        proposed: groupActionsByStatus(projectedProposedActions),
        applied: groupActionsByStatus(projectedAppliedActions),
      };
      const transitionReport = projectedArtifact?.transitionReport
        ? {
            proposed:
              hasGroupedGovernanceActions(projectedArtifact.transitionReport.proposed) || projectedProposedActions.length === 0
                ? projectedArtifact.transitionReport.proposed
                : fallbackTransitionReport.proposed,
            applied:
              hasGroupedGovernanceActions(projectedArtifact.transitionReport.applied) || projectedAppliedActions.length === 0
                ? projectedArtifact.transitionReport.applied
                : fallbackTransitionReport.applied,
          }
        : fallbackTransitionReport;
      const qualityScore = projectedArtifact?.qualityScore ?? metrics?.qualityScore ?? buildQualityScore(metrics?.reviewReasons ?? {
        exact_duplicate: 0,
        semantic_duplicate_candidate: 0,
        disputed_memory: 0,
        speculative_low_confidence: 0,
        archive_candidate: 0,
        explicit_capture_review: 0,
        malformed_import: 0,
      });
      const effectiveMetrics = metrics ? { ...metrics, qualityScore: metrics.qualityScore ?? qualityScore } : metrics;

      return {
        found: true,
        namespace: resolvedNamespace,
        runId: projected.runId,
        summary: projected.summary as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["summary"],
        metrics: effectiveMetrics,
        qualityScore,
        reviewQueue: projected.reviewQueueRows.map((row) => ({
          entryId: row.entryId,
          memoryId: row.memoryId,
          path: row.path,
          reasonCode: row.reasonCode,
          severity: row.severity,
          suggestedAction: row.suggestedAction,
          suggestedStatus: row.suggestedStatus,
          relatedMemoryIds: row.relatedMemoryIds,
        })) as Awaited<
          ReturnType<typeof readMemoryGovernanceRunArtifact>
        >["reviewQueue"],
        appliedActions: projectedAppliedActions,
        transitionReport,
        report: projected.report,
      };
    }

    const resolvedRunId = runId?.trim() || (await listMemoryGovernanceRuns(storage.dir))[0];
    if (!resolvedRunId) return { found: false, namespace: resolvedNamespace };
    const artifact = await readMemoryGovernanceRunArtifact(storage.dir, resolvedRunId);
    return {
      found: true,
      namespace: resolvedNamespace,
      runId: resolvedRunId,
      summary: artifact.summary,
      metrics: artifact.metrics,
      qualityScore: artifact.qualityScore,
      reviewQueue: artifact.reviewQueue,
      appliedActions: artifact.appliedActions,
      transitionReport: artifact.transitionReport,
      report: artifact.report,
    };
  }

  async maintenance(namespace?: string, principal?: string): Promise<EngramAccessMaintenanceResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    return {
      namespace: resolvedNamespace,
      health: await this.health(resolvedNamespace),
      latestGovernanceRun: await this.reviewQueue(undefined, resolvedNamespace, principal),
    };
  }

  async quality(namespace?: string, principal?: string): Promise<EngramAccessQualityResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const governance = await this.reviewQueue(undefined, resolvedNamespace, principal);
    const nowMs = Date.now();
    const statusCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    const confidenceTierCounts: Record<string, number> = {};
    const ageBucketCounts: Record<string, number> = {};
    let staleActive = 0;
    let lowConfidenceActive = 0;

    const memories = [...await storage.readAllMemories(), ...await storage.readArchivedMemories()];
    for (const memory of memories) {
      const status = inferMemoryStatus(memory.frontmatter, toMemoryPathRel(storage.dir, memory.path)).toLowerCase();
      const confidenceTier = memory.frontmatter.confidenceTier ?? "unknown";
      const ageBucket = bucketMemoryAge(memory.frontmatter.updated ?? memory.frontmatter.created, nowMs);

      incrementCount(statusCounts, status);
      incrementCount(categoryCounts, memory.frontmatter.category);
      incrementCount(confidenceTierCounts, confidenceTier);
      incrementCount(ageBucketCounts, ageBucket);

      if (status === "active") {
        if (ageBucket === "91_plus_days") staleActive += 1;
        if ((memory.frontmatter.confidence ?? 0) < 0.6) lowConfidenceActive += 1;
      }
    }

    return {
      namespace: resolvedNamespace,
      totalMemories: memories.length,
      statusCounts,
      categoryCounts,
      confidenceTierCounts,
      ageBucketCounts,
      archivePressure: {
        pendingReview: statusCounts.pending_review ?? 0,
        quarantined: statusCounts.quarantined ?? 0,
        archived: statusCounts.archived ?? 0,
        staleActive,
        lowConfidenceActive,
      },
      latestGovernanceRun: {
        found: governance.found,
        runId: governance.runId,
        qualityScore: governance.qualityScore ?? governance.metrics?.qualityScore,
        reviewQueueCount: governance.reviewQueue?.length ?? 0,
      },
    };
  }

  async governanceRun(
    request: {
      namespace?: string;
      mode?: "shadow" | "apply";
      recentDays?: number;
      maxMemories?: number;
      batchSize?: number;
      authenticatedPrincipal?: string;
    },
    principal?: string,
  ): Promise<{
    namespace: string;
    runId: string;
    traceId: string;
    mode: "shadow" | "apply";
    reviewQueueCount: number;
    proposedActionCount: number;
    appliedActionCount: number;
    summaryPath: string;
    reportPath: string;
  }> {
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal ?? principal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const result = await runMemoryGovernance({
      memoryDir: storage.dir,
      mode: request.mode === "apply" ? "apply" : "shadow",
      recentDays:
        typeof request.recentDays === "number" && Number.isFinite(request.recentDays)
          ? Math.max(1, Math.floor(request.recentDays))
          : undefined,
      maxMemories:
        typeof request.maxMemories === "number" && Number.isFinite(request.maxMemories)
          ? Math.max(1, Math.floor(request.maxMemories))
          : undefined,
      batchSize:
        typeof request.batchSize === "number" && Number.isFinite(request.batchSize)
          ? Math.max(1, Math.floor(request.batchSize))
          : undefined,
    });

    return {
      namespace: resolvedNamespace,
      runId: result.runId,
      traceId: result.traceId,
      mode: result.mode,
      reviewQueueCount: result.reviewQueue.length,
      proposedActionCount: result.proposedActions.length,
      appliedActionCount: result.appliedActions.length,
      summaryPath: result.summaryPath,
      reportPath: result.reportPath,
    };
  }

  async trustZoneStatus(namespace?: string, principal?: string): Promise<EngramAccessTrustZoneStatusResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    return {
      namespace: resolvedNamespace,
      status: await getTrustZoneStoreStatus({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: this.orchestrator.config.trustZonesEnabled === true,
        promotionEnabled: this.orchestrator.config.quarantinePromotionEnabled === true,
        poisoningDefenseEnabled: this.orchestrator.config.memoryPoisoningDefenseEnabled === true,
      }),
    };
  }

  async trustZoneBrowse(
    request: EngramAccessTrustZoneBrowseRequest,
    principal?: string,
  ): Promise<EngramAccessTrustZoneBrowseResponse> {
    const resolvedNamespace = this.resolveReadableNamespace(request.namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const result = await listTrustZoneRecords({
      memoryDir: storage.dir,
      trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
      query: request.query,
      zone: request.zone,
      kind: request.kind,
      sourceClass: request.sourceClass,
      limit: request.limit,
      offset: request.offset,
    });
    return {
      namespace: resolvedNamespace,
      total: result.total,
      count: result.count,
      limit: result.limit,
      offset: result.offset,
      records: result.records.map((entry) =>
        summarizeTrustZoneRecord(
          entry.record,
          entry.filePath,
          result.allRecords,
          this.orchestrator.config.memoryPoisoningDefenseEnabled === true,
          this.orchestrator.config.trustZonesEnabled === true,
          this.orchestrator.config.quarantinePromotionEnabled === true,
        )),
    };
  }

  async trustZonePromote(
    request: EngramAccessTrustZonePromoteRequest,
  ): Promise<EngramAccessTrustZonePromoteResponse> {
    if (!isTrustZoneName(request.targetZone)) {
      throw new EngramAccessInputError(`unsupported trust-zone target: ${String(request.targetZone)}`);
    }
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    let result: TrustZonePromotionResult;
    try {
      result = await promoteTrustZoneRecord({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: this.orchestrator.config.trustZonesEnabled === true,
        promotionEnabled: this.orchestrator.config.quarantinePromotionEnabled === true,
        poisoningDefenseEnabled: this.orchestrator.config.memoryPoisoningDefenseEnabled === true,
        sourceRecordId: request.recordId,
        targetZone: request.targetZone,
        recordedAt: request.recordedAt ?? new Date().toISOString(),
        promotionReason: request.promotionReason,
        summary: request.summary,
        dryRun: request.dryRun === true,
      });
    } catch (error) {
      throw normalizeTrustZoneInputError(error) ?? error;
    }
    return {
      namespace: resolvedNamespace,
      ...result,
      dryRun: request.dryRun === true,
    };
  }

  async trustZoneDemoSeed(
    request: EngramAccessTrustZoneDemoSeedRequest,
  ): Promise<EngramAccessTrustZoneDemoSeedResponse> {
    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    let result: TrustZoneDemoSeedResult;
    try {
      result = await seedTrustZoneDemoDataset({
        memoryDir: storage.dir,
        trustZoneStoreDir: this.orchestrator.config.trustZoneStoreDir,
        enabled: this.orchestrator.config.trustZonesEnabled === true,
        scenario: request.scenario,
        recordedAt: request.recordedAt,
        dryRun: request.dryRun === true,
      });
    } catch (error) {
      throw normalizeTrustZoneInputError(error) ?? error;
    }
    return {
      namespace: resolvedNamespace,
      ...result,
    };
  }

  async reviewDisposition(
    request: EngramAccessReviewDispositionRequest,
  ): Promise<EngramAccessReviewDispositionResponse> {
    const memoryId = request.memoryId.trim();
    const reasonCode = request.reasonCode.trim();
    if (memoryId.length === 0) {
      throw new EngramAccessInputError("memoryId is required");
    }
    if (reasonCode.length === 0) {
      throw new EngramAccessInputError("reasonCode is required");
    }

    const resolvedNamespace = this.resolveWritableNamespace(
      request.namespace,
      undefined,
      request.authenticatedPrincipal,
    );
    const storage = await this.orchestrator.getStorage(resolvedNamespace);
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) {
      throw new EngramAccessInputError(`memory not found: ${memoryId}`);
    }

    const previousStatus = memory.frontmatter.status ?? "active";
    const updatedAt = new Date().toISOString();
    const lifecycle = {
      actor: "admin-console.review-disposition",
      reasonCode,
      ruleVersion: "memory-governance.v1",
    };

    if (request.status === "archived") {
      const archivedPath = await storage.archiveMemory(memory, {
        at: new Date(updatedAt),
        ...lifecycle,
      });
      if (!archivedPath) {
        throw new Error(`failed to archive memory disposition: ${memoryId}`);
      }
      return {
        ok: true,
        namespace: resolvedNamespace,
        memoryId,
        status: "archived",
        previousStatus,
        currentPath: archivedPath,
      };
    }

    const updated = await storage.writeMemoryFrontmatter(memory, {
      status: request.status,
      updated: updatedAt,
    }, lifecycle);
    if (!updated) {
      throw new Error(`failed to update memory disposition: ${memoryId}`);
    }
    return {
      ok: true,
      namespace: resolvedNamespace,
      memoryId,
      status: request.status,
      previousStatus,
      currentPath: memory.path,
    };
  }

  private serializeMemory(memory: MemoryFile): EngramAccessMemoryRecord {
    return {
      id: memory.frontmatter.id,
      path: memory.path,
      category: memory.frontmatter.category,
      status: memory.frontmatter.status,
      created: memory.frontmatter.created,
      updated: memory.frontmatter.updated,
      content: memory.content,
      frontmatter: memory.frontmatter,
    };
  }

  private serializeMemorySummary(memory: MemoryFile, baseDir: string): EngramAccessMemorySummary {
    return {
      id: memory.frontmatter.id,
      path: memory.path,
      category: memory.frontmatter.category,
      status: inferMemoryStatus(memory.frontmatter, toMemoryPathRel(baseDir, memory.path)),
      created: memory.frontmatter.created,
      updated: memory.frontmatter.updated,
      tags: normalizeProjectionTags(memory.frontmatter.tags),
      entityRef: memory.frontmatter.entityRef,
      preview: normalizeProjectionPreview(memory.content),
    };
  }

  async observe(request: EngramAccessObserveRequest): Promise<EngramAccessObserveResponse> {
    if (!request.sessionKey || typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
      throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
    }
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new EngramAccessInputError("messages is required and must be a non-empty array");
    }
    for (const msg of request.messages) {
      if (!msg || typeof msg !== "object" || typeof msg.role !== "string" || typeof msg.content !== "string") {
        throw new EngramAccessInputError("each message must have a string 'role' and 'content'");
      }
      if (msg.role !== "user" && msg.role !== "assistant") {
        throw new EngramAccessInputError(`invalid message role: ${msg.role} (expected 'user' or 'assistant')`);
      }
    }

    const namespace = this.resolveWritableNamespace(
      request.namespace,
      request.sessionKey,
      request.authenticatedPrincipal,
    );

    // Prefix sessionKey with namespace for LCM archival so turns are namespace-scoped.
    // This ensures multi-tenant isolation in the LCM archive.
    const lcmSessionKey = namespace !== this.orchestrator.config.defaultNamespace
      ? `${namespace}:${request.sessionKey}`
      : request.sessionKey;

    // lcmArchived in the response means "LCM archival was queued" (not
    // "completed"), matching extractionQueued semantics.  Both run async.
    let lcmArchived = false;
    if (this.orchestrator.lcmEngine && this.orchestrator.lcmEngine.enabled) {
      // Fire-and-forget: LCM archival writes to SQLite and builds summary
      // DAGs, which can take tens of seconds for large sessions.  Don't
      // block the HTTP response — the caller only needs acknowledgment.
      try {
        this.orchestrator.lcmEngine.enqueueObserveMessages(lcmSessionKey, request.messages);
        lcmArchived = true;
      } catch (err) {
        log.error(`access-observe LCM enqueue failed: ${err}`);
      }
    }

    let extractionQueued = false;
    if (request.skipExtraction !== true) {
      const turns = request.messages.map((m) => ({
        source: "openclaw" as const,
        sessionKey: lcmSessionKey,
        role: m.role,
        content: m.content,
        timestamp: new Date().toISOString(),
      }));
      // Fire-and-forget: queue extraction in the background so the HTTP
      // response returns immediately. LCM archival (above) is also
      // enqueue-only; extraction involves LLM calls that can take
      // minutes under load and should not block the caller.
      //
      // Backpressure: the orchestrator's own extraction queue already
      // limits concurrency (one extraction at a time per session via
      // queueBufferedExtraction). Fire-and-forget here just decouples
      // the HTTP response from the queue drain.
      try {
        const extractionPromise = this.orchestrator.ingestReplayBatch(turns);
        extractionPromise.catch((err) => {
          log.error(`access-observe background extraction failed: ${err}`);
        });
        extractionQueued = true;
      } catch (err) {
        // Synchronous enqueue failure (e.g. orchestrator disposed)
        log.error(`access-observe extraction enqueue failed: ${err}`);
      }
    }

    log.info(
      `access-observe namespace=${namespace} sessionKey=${request.sessionKey} messages=${request.messages.length} lcm=${lcmArchived} extraction=${extractionQueued}`,
    );

    return {
      accepted: request.messages.length,
      sessionKey: request.sessionKey,
      namespace,
      lcmArchived,
      extractionQueued,
    };
  }

  async lcmSearch(request: EngramAccessLcmSearchRequest): Promise<EngramAccessLcmSearchResponse> {
    if (!request.query || typeof request.query !== "string" || request.query.trim().length === 0) {
      throw new EngramAccessInputError("query is required and must be a non-empty string");
    }

    const principal = this.resolveWritePrincipal(request.sessionKey, request.authenticatedPrincipal);
    const namespace = this.resolveReadableNamespace(request.namespace, principal);

    if (!this.orchestrator.lcmEngine || !this.orchestrator.lcmEngine.enabled) {
      return {
        query: request.query,
        namespace,
        results: [],
        count: 0,
        lcmEnabled: false,
      };
    }

    const limit = Math.max(1, Math.min(request.limit ?? 10, 100));
    const lcmSessionKey = request.sessionKey && namespace !== this.orchestrator.config.defaultNamespace
      ? `${namespace}:${request.sessionKey}`
      : request.sessionKey;
    const rawResults = await this.orchestrator.lcmEngine.searchContextFull(
      request.query,
      limit,
      lcmSessionKey,
    );

    const results = rawResults.map((r: { session_id: string; content: string; turn_index: number }) => ({
      sessionId: r.session_id,
      content: r.content,
      turnIndex: r.turn_index,
    }));

    return {
      query: request.query,
      namespace,
      results,
      count: results.length,
      lcmEnabled: true,
    };
  }

  // ── Parity tools (match OpenClaw plugin feature set) ──────────────────

  async memorySearch(request: {
    query: string;
    namespace?: string;
    maxResults?: number;
    collection?: string;
    principal?: string;
  }): Promise<{ query: string; results: Array<{ path: string; score: number; snippet: string }>; count: number }> {
    const { query, namespace, maxResults, collection, principal } = request;
    const resolvedNs = this.resolveReadableNamespace(namespace, principal);
    const namespaceFilter = resolvedNs !== this.orchestrator.config.defaultNamespace ? resolvedNs : undefined;

    const results = collection === "global"
      ? (await this.orchestrator.qmd.searchGlobal(query, maxResults)).filter((r) =>
          namespaceFilter
            ? r.path.includes(`/namespaces/${namespaceFilter}/`) ||
              (!r.path.includes("/namespaces/") && namespaceFilter === this.orchestrator.config.defaultNamespace)
            : true,
        )
      : await this.orchestrator.searchAcrossNamespaces({
          query,
          namespaces: namespaceFilter ? [namespaceFilter] : undefined,
          maxResults,
          mode: "search",
        });

    return {
      query,
      results: results.map((r) => ({
        path: r.path,
        score: r.score,
        snippet: (r.snippet ?? "").slice(0, 800),
      })),
      count: results.length,
    };
  }

  async memoryProfile(namespace?: string, principal?: string): Promise<Record<string, unknown>> {
    const resolvedNs = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const profile = await storage.readProfile();
    return {
      profile: profile || "No profile built yet. The profile builds automatically through conversations.",
    };
  }

  async memoryEntitiesList(namespace?: string, principal?: string): Promise<{ entities: string[]; count: number }> {
    const resolvedNs = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const entities = await storage.readEntities();
    return { entities, count: entities.length };
  }

  async memoryQuestions(namespace?: string, principal?: string): Promise<{ questions: Array<{ id: string; question: string; resolved: boolean }>; count: number }> {
    const resolvedNs = this.resolveReadableNamespace(namespace, principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const questions = await storage.readQuestions();
    return {
      questions: questions.map((q) => ({ id: q.id, question: q.question, resolved: q.resolved })),
      count: questions.length,
    };
  }

  async lastRecallSnapshot(sessionKey?: string): Promise<unknown> {
    const snapshot = sessionKey
      ? this.orchestrator.lastRecall.get(sessionKey)
      : this.orchestrator.lastRecall.getMostRecent();
    return snapshot ?? { message: "No recall snapshot available" };
  }

  async intentDebug(namespace?: string): Promise<unknown> {
    const snapshot = await this.orchestrator.getLastIntentSnapshot(namespace);
    return snapshot ?? { message: "No intent debug snapshot available" };
  }

  async qmdDebug(namespace?: string): Promise<unknown> {
    const snapshot = await this.orchestrator.getLastQmdRecallSnapshot(namespace);
    return snapshot ?? { message: "No QMD debug snapshot available" };
  }

  async graphExplainLastRecall(namespace?: string): Promise<unknown> {
    const explanation = await this.orchestrator.explainLastGraphRecall({ namespace });
    return { explanation };
  }

  async memoryFeedback(request: {
    memoryId: string;
    vote: "up" | "down";
    note?: string;
  }): Promise<{ recorded: boolean; enabled?: boolean; reason?: string }> {
    if (!this.orchestrator.config.feedbackEnabled) {
      return {
        recorded: false,
        enabled: false,
        reason: "Feedback is disabled. Enable `feedbackEnabled: true` in the Engram config to store feedback.",
      };
    }
    await this.orchestrator.recordMemoryFeedback(
      request.memoryId,
      request.vote,
      request.note,
    );
    return { recorded: true };
  }

  async memoryPromote(request: {
    memoryId: string;
    namespace?: string;
    principal?: string;
    sessionKey?: string;
  }): Promise<unknown> {
    const resolvedNs = this.resolveWritableNamespace(request.namespace, request.sessionKey, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    // Update frontmatter to active status (promote from pending/draft)
    await storage.updateMemoryFrontmatter(request.memoryId, {
      lifecycleState: "active",
      updated: new Date().toISOString(),
    });
    return { promoted: true, memoryId: request.memoryId };
  }

  async contextCheckpoint(request: {
    sessionKey: string;
    context: string;
    namespace?: string;
    principal?: string;
  }): Promise<{ saved: boolean }> {
    const resolvedNs = this.resolveWritableNamespace(request.namespace, request.sessionKey, request.principal);
    const storage = await this.orchestrator.getStorage(resolvedNs);
    const storageDir = storage.dir;
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join, resolve } = await import("node:path");
    // Sanitize sessionKey to prevent path traversal
    const safeKey = request.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeKey) throw new EngramAccessInputError("sessionKey is required");
    const checkpointDir = join(storageDir, "checkpoints", safeKey);
    // Double-check resolved path stays inside storageDir
    const resolved = resolve(checkpointDir);
    if (!resolved.startsWith(resolve(storageDir))) {
      throw new EngramAccessInputError("Invalid sessionKey");
    }
    await mkdir(checkpointDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(checkpointDir, `checkpoint-${ts}.md`);
    await writeFile(filePath, request.context, "utf-8");
    return { saved: true };
  }

  async lcmStatus(): Promise<EngramAccessLcmStatusResponse> {
    if (!this.orchestrator.lcmEngine || !this.orchestrator.lcmEngine.enabled) {
      return {
        enabled: false,
        archiveAvailable: false,
      };
    }

    const stats = await this.orchestrator.lcmEngine.getStats();
    return {
      enabled: true,
      archiveAvailable: true,
      stats: {
        totalTurns: stats.totalMessages,
      },
    };
  }
}
