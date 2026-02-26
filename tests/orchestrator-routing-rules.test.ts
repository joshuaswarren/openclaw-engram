import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { RoutingRulesStore } from "../src/routing/store.js";
import type { ExtractionResult } from "../src/types.js";

test("persistExtraction applies routing rule category+namespace targets", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-orchestrator-routing-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    routingRulesEnabled: true,
    routingRulesStateFile: "state/routing-rules.json",
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    multiGraphMemoryEnabled: false,
    verbatimArtifactsEnabled: false,
  });

  const orchestrator = new Orchestrator(config) as any;
  const defaultStorage = await orchestrator.getStorage("default");
  const sharedStorage = await orchestrator.getStorage("shared");
  await defaultStorage.ensureDirectories();
  await sharedStorage.ensureDirectories();

  const ruleStore = new RoutingRulesStore(memoryDir, config.routingRulesStateFile);
  await ruleStore.upsert({
    id: "route-incident-shared",
    patternType: "keyword",
    pattern: "incident",
    priority: 100,
    target: {
      category: "decision",
      namespace: "shared",
    },
  });

  const result: ExtractionResult = {
    facts: [
      {
        content: "incident #42 in prod cluster",
        category: "fact",
        confidence: 0.9,
        tags: ["ops"],
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
    observations: [],
  };

  const persisted = await orchestrator.persistExtraction(result, defaultStorage, null);
  assert.equal(persisted.length, 1);

  const sharedMemories = await sharedStorage.readAllMemories();
  const defaultMemories = await defaultStorage.readAllMemories();
  assert.equal(sharedMemories.length, 1);
  assert.equal(defaultMemories.length, 0);
  assert.equal(sharedMemories[0]?.frontmatter.category, "decision");
});
