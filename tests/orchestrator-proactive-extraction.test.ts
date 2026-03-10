import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ExtractionResult } from "../src/types.js";

test("persistExtraction records proactive-pass facts with distinct extraction provenance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-proactive-provenance-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
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
