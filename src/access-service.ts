import { stat } from "node:fs/promises";
import type { Orchestrator } from "./orchestrator.js";
import { getMemoryProjectionPath } from "./memory-projection-store.js";
import type { LastRecallSnapshot } from "./recall-state.js";
import type { MemoryFile, MemoryLifecycleEvent } from "./types.js";

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
}
