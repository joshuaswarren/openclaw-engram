import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { EngramAccessInputError, EngramAccessService } from "../src/access-service.js";
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
