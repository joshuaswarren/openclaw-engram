import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ExtractionResult } from "../src/types.js";

function longChunkCandidate(prefix: string): string {
  return Array.from(
    { length: 120 },
    (_, idx) => `${prefix} sentence ${idx + 1} adds deterministic chunking coverage.`,
  ).join(" ");
}

test("persistExtraction records proactive-pass facts with distinct extraction provenance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-proactive-provenance-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();

  const result: ExtractionResult = {
    facts: [
      {
        category: "fact",
        content: "Base extraction memory.",
        confidence: 0.9,
        tags: ["base"],
        source: "base",
      },
      {
        category: "fact",
        content: "Proactive extraction memory.",
        confidence: 0.92,
        tags: ["proactive"],
        source: "proactive",
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };

  const persistedIds = await orchestrator.persistExtraction(result, storage, null);
  assert.equal(persistedIds.length, 2);

  const baseMemory = await storage.getMemoryById(persistedIds[0]);
  const proactiveMemory = await storage.getMemoryById(persistedIds[1]);

  assert.equal(baseMemory?.frontmatter.source, "extraction");
  assert.equal(proactiveMemory?.frontmatter.source, "extraction-proactive");
});

test("persistExtraction preserves base chunk source metadata while tagging proactive chunks distinctly", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-proactive-chunk-source-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();

  const result: ExtractionResult = {
    facts: [
      {
        category: "fact",
        content: longChunkCandidate("Base chunk source"),
        confidence: 0.9,
        tags: ["base"],
        source: "base",
      },
      {
        category: "fact",
        content: longChunkCandidate("Proactive chunk source"),
        confidence: 0.92,
        tags: ["proactive"],
        source: "proactive",
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };

  const persistedIds = await orchestrator.persistExtraction(result, storage, null);
  const persistedMemories = await Promise.all(persistedIds.map((id: string) => storage.getMemoryById(id)));
  const parentMemories = persistedMemories.filter(
    (memory): memory is NonNullable<typeof memory> =>
      !!memory && !memory.frontmatter.parentId && memory.frontmatter.tags.includes("chunked"),
  );

  const baseParent = parentMemories.find((memory) => memory.frontmatter.source === "extraction");
  const proactiveParent = parentMemories.find((memory) => memory.frontmatter.source === "extraction-proactive");
  assert.ok(baseParent);
  assert.ok(proactiveParent);

  const baseChunk = (await storage.getChunksForParent(baseParent.frontmatter.id))[0];
  const proactiveChunk = (await storage.getChunksForParent(proactiveParent.frontmatter.id))[0];

  assert.ok(baseChunk);
  assert.ok(proactiveChunk);
  assert.equal(baseChunk.frontmatter.source, "chunking");
  assert.equal(proactiveChunk.frontmatter.source, "chunking-proactive");
});
