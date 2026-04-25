import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";
import { promoteSemanticRuleFromMemory } from "../src/semantic-rule-promotion.js";
import {
  runSemanticRuleVerifyCliCommand,
} from "../src/cli.js";
import {
  searchVerifiedSemanticRules,
} from "../src/semantic-rule-verifier.js";

async function createSemanticRuleHarness() {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-semantic-rule-verify-"));
  const storage = new StorageManager(memoryDir);
  return { memoryDir, storage };
}

async function seedPromotedRule(memoryDir: string, storage: StorageManager) {
  const sourceMemoryId = await storage.writeMemory(
    "fact",
    "IF Cursor Bugbot is still pending THEN wait for the terminal result before merging.",
    {
      source: "test",
      tags: ["pr-loop", "cursor"],
      confidence: 0.92,
      memoryKind: "episode",
    },
  );

  const promotion = await promoteSemanticRuleFromMemory({
    memoryDir,
    enabled: true,
    sourceMemoryId,
  });

  assert.equal(promotion.promoted.length, 1);
  return {
    sourceMemoryId,
    ruleMemoryId: promotion.promoted[0]!.id,
  };
}

test("searchVerifiedSemanticRules returns promoted rules whose source episode still verifies", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { ruleMemoryId, sourceMemoryId } = await seedPromotedRule(memoryDir, storage);

  const results = await searchVerifiedSemanticRules({
    memoryDir,
    query: "What rule says to wait for Cursor before merging?",
    maxResults: 3,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.rule.frontmatter.id, ruleMemoryId);
  assert.equal(results[0]?.sourceMemoryId, sourceMemoryId);
  assert.equal(results[0]?.verificationStatus, "verified");
  assert.equal((results[0]?.effectiveConfidence ?? 0) > 0.8, true);
});

test("searchVerifiedSemanticRules downgrades archived-source rules below the default recall threshold", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { ruleMemoryId, sourceMemoryId } = await seedPromotedRule(memoryDir, storage);
  const sourceMemory = await storage.getMemoryById(sourceMemoryId);
  assert.ok(sourceMemory);
  await storage.writeMemoryFrontmatter(sourceMemory, {
    status: "archived",
    archivedAt: "2026-03-08T00:00:00.000Z",
  });

  const results = await searchVerifiedSemanticRules({
    memoryDir,
    query: "What rule says to wait for Cursor before merging?",
    maxResults: 3,
  });

  assert.deepEqual(results, []);

  const diagnosticResults = await searchVerifiedSemanticRules({
    memoryDir,
    query: "What rule says to wait for Cursor before merging?",
    maxResults: 3,
    minEffectiveConfidence: 0.1,
  });
  assert.equal(diagnosticResults.length, 1);
  assert.equal(diagnosticResults[0]?.rule.frontmatter.id, ruleMemoryId);
  assert.equal(diagnosticResults[0]?.verificationStatus, "source-memory-archived");
  assert.equal(diagnosticResults[0]?.sourceMemoryId, sourceMemoryId);
});

test("semantic-rule-verify CLI command honors the verification feature flag", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  const { ruleMemoryId } = await seedPromotedRule(memoryDir, storage);

  const disabled = await runSemanticRuleVerifyCliCommand({
    memoryDir,
    semanticRuleVerificationEnabled: false,
    query: "wait for Cursor before merging",
    maxResults: 3,
  });
  assert.deepEqual(disabled, []);

  const enabled = await runSemanticRuleVerifyCliCommand({
    memoryDir,
    semanticRuleVerificationEnabled: true,
    query: "wait for Cursor before merging",
    maxResults: 3,
  });
  assert.equal(enabled[0]?.rule.frontmatter.id, ruleMemoryId);
});

test("recall injects verified semantic rules only when the verifier flag and recall section are enabled", async () => {
  const { memoryDir, storage } = await createSemanticRuleHarness();
  await seedPromotedRule(memoryDir, storage);

  const enabled = new Orchestrator(parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    semanticRulePromotionEnabled: true,
    semanticRuleVerificationEnabled: true,
    recallPipeline: [
      {
        id: "verified-rules",
        enabled: true,
        maxResults: 3,
        maxChars: 1800,
      },
    ],
  }));

  const enabledContext = await (enabled as any).recallInternal(
    "What rule says to wait for Cursor before merging?",
    "agent:main",
  );
  assert.match(enabledContext, /## Verified Rules/);
  assert.match(enabledContext, /wait for the terminal result before merging/i);

  const disabled = new Orchestrator(parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    semanticRulePromotionEnabled: true,
    semanticRuleVerificationEnabled: false,
    recallPipeline: [
      {
        id: "verified-rules",
        enabled: true,
        maxResults: 3,
        maxChars: 1800,
      },
    ],
  }));

  const disabledContext = await (disabled as any).recallInternal(
    "What rule says to wait for Cursor before merging?",
    "agent:main",
  );
  assert.equal(disabledContext.includes("## Verified Rules"), false);
});
