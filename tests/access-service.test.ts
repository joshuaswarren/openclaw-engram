import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { EngramAccessInputError, EngramAccessService } from "../src/access-service.js";
import { runMemoryGovernance } from "../src/maintenance/memory-governance.ts";
import { rebuildMemoryProjection } from "../src/maintenance/rebuild-memory-projection.ts";
import { StorageManager } from "../src/storage.js";

function createService() {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  return new EngramAccessService(orchestrator as any);
}

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function memoryDoc(id: string, content: string, extra: string[] = []): string {
  return [
    "---",
    `id: ${id}`,
    "category: fact",
    "created: 2026-03-01T00:00:00.000Z",
    "updated: 2026-03-08T00:00:00.000Z",
    "source: test",
    "confidence: 0.9",
    "confidenceTier: explicit",
    "tags: [\"ops\", \"admin\"]",
    ...extra,
    "---",
    "",
    content,
    "",
  ].join("\n");
}

test("access service rejects empty recall queries as input errors", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({ query: "   " }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "query is required",
  );
});

test("access service rejects unsupported namespace-scoped recall", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({ query: "hello", namespace: "project-x" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /namespace-scoped recall is not implemented/.test(err.message),
  );
});

test("access service browses memories, lists entities, and applies review dispositions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      memoryDoc("fact-1", "Admin console memory browser target.", ['entityRef: person-alex', 'status: pending_review']),
    );
    await writeText(
      memoryDir,
      "entities/person-alex.md",
      [
        "# Alex",
        "",
        "type: person",
        "updated: 2026-03-08T00:00:00.000Z",
        "",
        "## Summary",
        "",
        "Owns operations tooling.",
        "",
        "## Aliases",
        "",
        "- Alex Ops",
        "",
        "## Facts",
        "",
        "- Maintains Engram.",
        "",
      ].join("\n"),
    );

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({ query: "browser" });
    assert.equal(browse.total, 1);
    assert.equal(browse.memories[0]?.id, "fact-1");

    const entities = await service.entityList({ query: "alex" });
    assert.equal(entities.total, 1);
    assert.equal(entities.entities[0]?.name, "Alex");

    const entity = await service.entityGet("person-alex");
    assert.equal(entity.found, true);
    assert.equal(entity.entity?.aliases.includes("Alex Ops"), true);

    const disposition = await service.reviewDisposition({
      memoryId: "fact-1",
      status: "active",
      reasonCode: "operator_confirmed",
    });
    assert.equal(disposition.ok, true);
    assert.equal(disposition.previousStatus, "pending_review");

    const updated = await storage.getMemoryById("fact-1");
    assert.equal(updated?.frontmatter.status, "active");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service uses projection-backed browse filters, including archived memories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-projection-browse-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-active.md",
      memoryDoc("fact-active", "Active memory that should be filtered out.", ['entityRef: person-active']),
    );
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      memoryDoc(
        "fact-archived",
        "Retired browser coverage memory for the archived projection path.",
        ['entityRef: person-retired', 'archivedAt: 2026-03-08T02:00:00.000Z', 'tags: ["legacy", "browser"]'],
      ),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({
      query: "retired",
      status: "archived",
      category: "fact",
    });
    assert.equal(browse.total, 1);
    assert.equal(browse.count, 1);
    assert.equal(browse.memories[0]?.id, "fact-archived");
    assert.equal(browse.memories[0]?.status, "archived");
    assert.equal(browse.memories[0]?.entityRef, "person-retired");
    assert.deepEqual([...((browse.memories[0]?.tags ?? []).slice())].sort(), ["browser", "legacy"]);
    assert.match(browse.memories[0]?.path ?? "", /archive\/2026-03-08\/fact-archived\.md$/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service projection browse matches full content beyond preview text", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-projection-content-"));
  try {
    const deepNeedle = "full content projection query";
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-deep.md",
      memoryDoc(
        "fact-deep",
        `${"alpha ".repeat(60)}${deepNeedle}`,
        ['entityRef: person-deep', 'tags: ["projection", "content"]'],
      ),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const browse = await service.memoryBrowse({
      query: deepNeedle,
      status: "active",
      category: "fact",
    });
    assert.equal(browse.total, 1);
    assert.equal(browse.count, 1);
    assert.equal(browse.memories[0]?.id, "fact-deep");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service reviewQueue and maintenance fall back to governance artifacts when projection is absent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-fallback-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc("fact-duplicate-a", "Exact duplicate for governance fallback coverage.", ['confidence: 0.95']),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc("fact-duplicate-b", "Exact duplicate for governance fallback coverage.", ['confidence: 0.45']),
    );

    const governance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const queue = await service.reviewQueue();
    assert.equal(queue.found, true);
    assert.equal(queue.runId, governance.runId);
    assert.equal(queue.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"), true);

    const maintenance = await service.maintenance();
    assert.equal(maintenance.health.projectionAvailable, false);
    assert.equal(maintenance.latestGovernanceRun.found, true);
    assert.equal(maintenance.latestGovernanceRun.runId, governance.runId);
    assert.equal(
      maintenance.latestGovernanceRun.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"),
      true,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access service serves reviewQueue and maintenance from projection when governance artifacts are gone", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-service-governance-projection-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc("fact-duplicate-a", "Exact duplicate for projection review queue coverage.", ['confidence: 0.95']),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc("fact-duplicate-b", "Exact duplicate for projection review queue coverage.", ['confidence: 0.45']),
    );

    const governance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-09T12:05:00.000Z"),
    });
    await rm(path.join(memoryDir, "state", "memory-governance"), { recursive: true, force: true });

    const storage = new StorageManager(memoryDir);
    const service = new EngramAccessService({
      config: {
        memoryDir,
        namespacesEnabled: false,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledge: undefined,
      },
      recall: async () => "ctx",
      lastRecall: { get: () => null, getMostRecent: () => null },
      getStorage: async () => storage,
    } as any);

    const queue = await service.reviewQueue(governance.runId);
    assert.equal(queue.found, true);
    assert.equal(queue.runId, governance.runId);
    assert.equal(queue.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"), true);

    const maintenance = await service.maintenance();
    assert.equal(maintenance.health.projectionAvailable, true);
    assert.equal(maintenance.latestGovernanceRun.found, true);
    assert.equal(maintenance.latestGovernanceRun.runId, governance.runId);
    assert.equal(
      maintenance.latestGovernanceRun.reviewQueue?.some((entry) => entry.reasonCode === "exact_duplicate"),
      true,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
