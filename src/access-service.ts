import { stat } from "node:fs/promises";
import type { Orchestrator } from "./orchestrator.js";
import {
  listMemoryGovernanceRuns,
  readMemoryGovernanceRunArtifact,
} from "./maintenance/memory-governance.js";
import {
  normalizeProjectionPreview,
  normalizeProjectionTags,
} from "./memory-projection-format.js";
import { inferMemoryStatus } from "./memory-lifecycle-ledger-utils.js";
import { getMemoryProjectionPath } from "./memory-projection-store.js";
import type { LastRecallSnapshot } from "./recall-state.js";
import { parseEntityFile } from "./storage.js";
import type { EntityFile, MemoryFile, MemoryLifecycleEvent, MemoryStatus } from "./types.js";

export class EngramAccessInputError extends Error {}

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
}

export interface EngramAccessRecallResponse {
  query: string;
  sessionKey?: string;
  context: string;
  count: number;
  memoryIds: string[];
  recordedAt?: string;
}

export interface EngramAccessRecallExplainRequest {
  sessionKey?: string;
}

export interface EngramAccessRecallExplainResponse {
  found: boolean;
  snapshot?: LastRecallSnapshot;
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
  limit?: number;
  offset?: number;
}

export interface EngramAccessMemoryBrowseResponse {
  namespace: string;
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
  runId?: string;
  summary?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["summary"];
  metrics?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["metrics"];
  reviewQueue?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["reviewQueue"];
  appliedActions?: Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["appliedActions"];
  report?: string;
}

export interface EngramAccessMaintenanceResponse {
  health: EngramAccessHealthResponse;
  latestGovernanceRun: EngramAccessReviewQueueResponse;
}

export interface EngramAccessReviewDispositionRequest {
  memoryId: string;
  status: MemoryStatus | "archived";
  reasonCode: string;
  namespace?: string;
}

export interface EngramAccessReviewDispositionResponse {
  ok: boolean;
  namespace: string;
  memoryId: string;
  status: MemoryStatus | "archived";
  previousStatus: MemoryStatus;
  currentPath?: string;
}

function normalizePagination(limit?: number, offset?: number): { limit: number; offset: number } {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit ?? 50))) : 50;
  const normalizedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset ?? 0)) : 0;
  return { limit: normalizedLimit, offset: normalizedOffset };
}

export class EngramAccessService {
  constructor(private readonly orchestrator: Orchestrator) {}

  async health(): Promise<EngramAccessHealthResponse> {
    let projectionAvailable = false;
    try {
      await stat(getMemoryProjectionPath(this.orchestrator.config.memoryDir));
      projectionAvailable = true;
    } catch {
      projectionAvailable = false;
    }

    return {
      ok: true,
      memoryDir: this.orchestrator.config.memoryDir,
      namespacesEnabled: this.orchestrator.config.namespacesEnabled === true,
      defaultNamespace: this.orchestrator.config.defaultNamespace,
      searchBackend: this.orchestrator.config.searchBackend ?? "qmd",
      qmdEnabled: this.orchestrator.config.qmdEnabled === true,
      nativeKnowledgeEnabled: this.orchestrator.config.nativeKnowledge?.enabled === true,
      projectionAvailable,
    };
  }

  async recall(request: EngramAccessRecallRequest): Promise<EngramAccessRecallResponse> {
    const query = request.query.trim();
    if (query.length === 0) {
      throw new EngramAccessInputError("query is required");
    }
    const requestedNamespace = request.namespace?.trim();
    if (
      requestedNamespace &&
      requestedNamespace !== this.orchestrator.config.defaultNamespace
    ) {
      throw new EngramAccessInputError(
        `namespace-scoped recall is not implemented for ${requestedNamespace}`,
      );
    }
    const context = await this.orchestrator.recall(query, request.sessionKey);
    const snapshot = request.sessionKey
      ? this.orchestrator.lastRecall.get(request.sessionKey)
      : this.orchestrator.lastRecall.getMostRecent();

    return {
      query,
      sessionKey: request.sessionKey,
      context,
      count: snapshot?.memoryIds.length ?? 0,
      memoryIds: snapshot?.memoryIds ?? [],
      recordedAt: snapshot?.recordedAt,
    };
  }

  async recallExplain(
    request: EngramAccessRecallExplainRequest = {},
  ): Promise<EngramAccessRecallExplainResponse> {
    const snapshot = request.sessionKey
      ? this.orchestrator.lastRecall.get(request.sessionKey)
      : this.orchestrator.lastRecall.getMostRecent();
    if (!snapshot) return { found: false };
    return { found: true, snapshot };
  }

  async memoryGet(memoryId: string, namespace?: string): Promise<EngramAccessMemoryResponse> {
    const storage = await this.orchestrator.getStorage(namespace);
    const resolvedNamespace = namespace?.trim() || this.orchestrator.config.defaultNamespace;
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
    const query = request.query?.trim().toLowerCase() ?? "";
    const statusFilter = request.status?.trim().toLowerCase();
    const categoryFilter = request.category?.trim().toLowerCase();

    const projected = await storage.browseProjectedMemories({
      query,
      status: statusFilter,
      category: categoryFilter,
      limit,
      offset,
    });
    if (projected) {
      return {
        namespace: resolvedNamespace,
        total: projected.total,
        count: projected.memories.length,
        limit,
        offset,
        memories: projected.memories.map((row) => ({ ...row })),
      };
    }

    let memories = [...await storage.readAllMemories(), ...await storage.readArchivedMemories()];
    memories = memories.filter((memory) => {
      const status = inferMemoryStatus(memory.frontmatter, memory.path).toLowerCase();
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

    memories.sort((left, right) => {
      const leftAt = left.frontmatter.updated ?? left.frontmatter.created ?? "";
      const rightAt = right.frontmatter.updated ?? right.frontmatter.created ?? "";
      return rightAt.localeCompare(leftAt);
    });

    const page = memories.slice(offset, offset + limit).map((memory) => this.serializeMemorySummary(memory));
    return {
      namespace: resolvedNamespace,
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
  ): Promise<EngramAccessTimelineResponse> {
    const storage = await this.orchestrator.getStorage(namespace);
    const resolvedNamespace = namespace?.trim() || this.orchestrator.config.defaultNamespace;
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

  async reviewQueue(runId?: string): Promise<EngramAccessReviewQueueResponse> {
    const storage = await this.orchestrator.getStorage();
    const projected = await storage.getProjectedGovernanceRecord();
    if (projected && (!runId || projected.runId === runId.trim())) {
      return {
        found: true,
        runId: projected.runId,
        summary: projected.summary as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["summary"],
        metrics: projected.metrics as Awaited<ReturnType<typeof readMemoryGovernanceRunArtifact>>["metrics"],
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
        appliedActions: projected.appliedActionRows.map((row) => ({
          action: row.action,
          memoryId: row.memoryId,
          reasonCode: row.reasonCode,
          beforeStatus: row.beforeStatus,
          afterStatus: row.afterStatus,
          originalPath: row.originalPath,
          currentPath: row.currentPath,
        })) as Awaited<
          ReturnType<typeof readMemoryGovernanceRunArtifact>
        >["appliedActions"],
        report: projected.report,
      };
    }

    const resolvedRunId = runId?.trim() || (await listMemoryGovernanceRuns(this.orchestrator.config.memoryDir))[0];
    if (!resolvedRunId) return { found: false };
    const artifact = await readMemoryGovernanceRunArtifact(this.orchestrator.config.memoryDir, resolvedRunId);
    return {
      found: true,
      runId: resolvedRunId,
      summary: artifact.summary,
      metrics: artifact.metrics,
      reviewQueue: artifact.reviewQueue,
      appliedActions: artifact.appliedActions,
      report: artifact.report,
    };
  }

  async maintenance(): Promise<EngramAccessMaintenanceResponse> {
    return {
      health: await this.health(),
      latestGovernanceRun: await this.reviewQueue(),
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

    const storage = await this.orchestrator.getStorage(request.namespace);
    const resolvedNamespace = request.namespace?.trim() || this.orchestrator.config.defaultNamespace;
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

  private serializeMemorySummary(memory: MemoryFile): EngramAccessMemorySummary {
    return {
      id: memory.frontmatter.id,
      path: memory.path,
      category: memory.frontmatter.category,
      status: inferMemoryStatus(memory.frontmatter, memory.path),
      created: memory.frontmatter.created,
      updated: memory.frontmatter.updated,
      tags: normalizeProjectionTags(memory.frontmatter.tags),
      entityRef: memory.frontmatter.entityRef,
      preview: normalizeProjectionPreview(memory.content),
    };
  }
}
