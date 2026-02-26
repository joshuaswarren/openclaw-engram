import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { RoutingRulesStore } from "../src/routing/store.js";
import { readEdges } from "../src/graph.js";
import { queryByTagsAsync } from "../src/temporal-index.js";
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
    queryAwareIndexingEnabled: true,
    multiGraphMemoryEnabled: true,
    causalGraphEnabled: true,
    graphWriteSessionAdjacencyEnabled: true,
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
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
      {
        content: "because of incident #42 we rolled back",
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
  assert.equal(persisted.length, 2);

  const sharedMemories = await sharedStorage.readAllMemories();
  const defaultMemories = await defaultStorage.readAllMemories();
  assert.equal(sharedMemories.length, 2);
  assert.equal(defaultMemories.length, 0);
  assert.equal(sharedMemories[0]?.frontmatter.category, "decision");

  let indexedPaths = await queryByTagsAsync(memoryDir, ["ops"]);
  for (let attempt = 0; (!indexedPaths || indexedPaths.size === 0) && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    indexedPaths = await queryByTagsAsync(memoryDir, ["ops"]);
  }
  assert.ok(indexedPaths && indexedPaths.size > 0);
  const sharedPathMatch = [...indexedPaths!].some((p) => p.includes(path.join("namespaces", "shared")));
  assert.equal(sharedPathMatch, true);

  const causalEdges = await readEdges(sharedStorage.dir, "causal");
  assert.ok(causalEdges.length > 0);
});
