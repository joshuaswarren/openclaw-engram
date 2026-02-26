import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("checkForContradiction resolves candidate memory in routed namespace storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-contradiction-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    contradictionDetectionEnabled: true,
    contradictionAutoResolve: true,
    contradictionSimilarityThreshold: 0.2,
    contradictionMinConfidence: 0.7,
  });

  const orchestrator = new Orchestrator(config) as any;
  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.ensureDirectories();

  const sharedId = await sharedStorage.writeMemory("fact", "legacy shared fact");
  const sharedMemory = await sharedStorage.getMemoryById(sharedId);
  assert.ok(sharedMemory);

  orchestrator.qmd = {
    isAvailable: () => true,
    search: async () => [
      {
        docid: sharedId,
        path: sharedMemory!.path,
        snippet: "legacy shared fact",
        score: 0.95,
      },
    ],
  };
  orchestrator.extraction = {
    verifyContradiction: async () => ({
      isContradiction: true,
      confidence: 0.95,
      reasoning: "new memory supersedes old shared fact",
      whichIsNewer: "second",
    }),
  };

  const contradiction = await orchestrator.checkForContradiction("new shared fact", "fact");
  assert.ok(contradiction);
  assert.equal(contradiction.supersededId, sharedId);

  const superseded = await sharedStorage.getMemoryById(sharedId);
  assert.equal(superseded?.frontmatter.status, "superseded");
});
