import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig keeps native knowledge disabled by default", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.nativeKnowledge, undefined);
  assert.equal(cfg.recallPipeline.some((section) => section.id === "native-knowledge"), true);
  const section = cfg.recallPipeline.find((entry) => entry.id === "native-knowledge");
  assert.equal(section?.enabled, false);
  assert.equal(section?.maxResults, 4);
  assert.equal(section?.maxChars, 2400);
});

test("parseConfig supports explicit native knowledge settings", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    nativeKnowledge: {
      enabled: true,
      includeFiles: ["IDENTITY.md", "TEAM.md", "  "],
      maxChunkChars: 1200,
      maxResults: 6,
      maxChars: 3000,
    },
  });

  assert.deepEqual(cfg.nativeKnowledge, {
    enabled: true,
    includeFiles: ["IDENTITY.md", "TEAM.md"],
    maxChunkChars: 1200,
    maxResults: 6,
    maxChars: 3000,
  });
  const section = cfg.recallPipeline.find((entry) => entry.id === "native-knowledge");
  assert.equal(section?.enabled, true);
  assert.equal(section?.maxResults, 6);
  assert.equal(section?.maxChars, 3000);
});
