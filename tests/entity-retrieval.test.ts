import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { buildEntityRecallSection, entityIndexVersion } from "../src/entity-retrieval.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager, normalizeEntityName } from "../src/storage.js";
import type { PluginConfig, TranscriptEntry } from "../src/types.js";

async function buildHarness(prefix: string, overrides: Record<string, unknown> = {}) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-memory-`));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-workspace-`));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    hourlySummariesEnabled: false,
    transcriptEnabled: true,
    nativeKnowledge: {
      enabled: false,
      includeFiles: ["IDENTITY.md", "MEMORY.md", "USER.md"],
      maxChunkChars: 400,
      maxResults: 5,
      maxChars: 1600,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
    ...overrides,
  });
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  return { memoryDir, workspaceDir, config, storage };
}

async function writeEntity(storage: StorageManager, name: string, type: string, facts: string[], summary: string, aliases: string[] = []) {
  await storage.writeEntity(name, type, facts);
  const canonical = normalizeEntityName(name, type);
  await storage.updateEntitySummary(canonical, summary);
  for (const alias of aliases) {
    await storage.addEntityAlias(canonical, alias);
  }
  return canonical;
}

async function buildSection(
  config: PluginConfig,
  storage: StorageManager,
  query: string,
  transcriptEntries: TranscriptEntry[] = [],
) {
  return buildEntityRecallSection({
    config,
    storage,
    query,
    recentTurns: 6,
    maxHints: 2,
    maxSupportingFacts: 6,
    maxRelatedEntities: 3,
    maxChars: 2400,
    transcriptEntries,
  });
}

test("entity retrieval builds answer hints and persists a mention index", async () => {
  const { memoryDir, config, storage } = await buildHarness("engram-entity-direct");
  const canonical = await writeEntity(
    storage,
    "Joshua Warren",
    "person",
    [
      "Joshua Warren builds OpenClaw Engram retrieval features.",
      "Joshua Warren prefers concise responses.",
      "Remember to ask Joshua Warren before changing release policy.",
    ],
    "Joshua Warren is the maintainer of OpenClaw Engram memory features.",
    ["Josh"],
  );
  await storage.writeMemory(
    "fact",
    "Joshua Warren previously landed the namespace migration tooling.",
    { entityRef: canonical, confidence: 0.95 },
  );

  const section = await buildSection(config, storage, "Who is Josh?");

  assert.ok(section);
  assert.match(section!, /## entity_answer_hints/);
  assert.match(section!, /target: Joshua Warren \(person\)/);
  assert.match(section!, /resolution: matched alias "Josh" in the query/);
  assert.match(section!, /likely answer:/);
  assert.doesNotMatch(section!, /Remember to ask Joshua Warren before changing release policy/);

  const index = JSON.parse(await readFile(path.join(memoryDir, "state", "entity-mention-index.json"), "utf-8"));
  assert.equal(index.version, entityIndexVersion);
  assert.ok(index.entities.some((entry: { canonicalId: string }) => entry.canonicalId === canonical));
});

test("entity retrieval preserves mention-index updatedAt when entity state is unchanged", async () => {
  const { memoryDir, config, storage } = await buildHarness("engram-entity-stable-index");
  await writeEntity(
    storage,
    "Stable Entity",
    "person",
    ["Stable Entity owns the unchanged index test."],
    "Stable Entity owns the unchanged index test.",
  );

  await buildSection(config, storage, "Who is Stable Entity?");
  const firstIndex = JSON.parse(await readFile(path.join(memoryDir, "state", "entity-mention-index.json"), "utf-8"));
  await buildSection(config, storage, "Who is Stable Entity?");
  const secondIndex = JSON.parse(await readFile(path.join(memoryDir, "state", "entity-mention-index.json"), "utf-8"));

  assert.equal(firstIndex.updatedAt, secondIndex.updatedAt);
});

test("entity retrieval resolves pronoun follow-ups from recent transcript turns", async () => {
  const { config, storage } = await buildHarness("engram-entity-followup");
  await writeEntity(
    storage,
    "Alice Example",
    "person",
    [
      "Alice Example leads the launch review.",
      "Alice Example coordinated last month's release freeze.",
    ],
    "Alice Example is the release lead for the launch review.",
  );

  const transcriptEntries: TranscriptEntry[] = [
    {
      timestamp: "2026-03-09T10:00:00.000Z",
      role: "user",
      content: "What do we know about Alice Example?",
      sessionKey: "user:test:entity-followup",
      turnId: "turn-1",
    },
    {
      timestamp: "2026-03-09T10:00:05.000Z",
      role: "assistant",
      content: "Alice Example is leading the launch review and release freeze.",
      sessionKey: "user:test:entity-followup",
      turnId: "turn-2",
    },
  ];

  const section = await buildSection(config, storage, "What happened with her last month?", transcriptEntries);

  assert.ok(section);
  assert.match(section!, /target: Alice Example \(person\)/);
  assert.match(section!, /resolution: carried forward from recent turns via alias "Alice Example"/);
  assert.match(section!, /recent timeline:/);
});

test("entity retrieval surfaces uncertainty when direct facts conflict", async () => {
  const { config, storage } = await buildHarness("engram-entity-conflict");
  await writeEntity(
    storage,
    "Casey Ops",
    "person",
    [
      "Casey Ops works at Northwind Labs.",
      "Casey Ops works at Contoso Systems.",
    ],
    "Casey Ops is an operations lead referenced in team memory.",
  );

  const section = await buildSection(config, storage, "What do we know about Casey Ops?");

  assert.ok(section);
  assert.match(section!, /uncertainty: Evidence is mixed across stored facts/);
});

test("entity retrieval can answer from native knowledge titles and aliases without an entity file", async () => {
  const { workspaceDir, config, storage } = await buildHarness("engram-entity-native", {
    nativeKnowledge: {
      enabled: true,
      includeFiles: ["IDENTITY.md"],
      maxChunkChars: 400,
      maxResults: 5,
      maxChars: 1600,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
  });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    "# Launch Runbook\n\nThe launch runbook tracks release freeze steps and rollback owners.\n",
    "utf-8",
  );

  const section = await buildSection(config, storage, "Tell me about Launch Runbook");

  assert.ok(section);
  assert.match(section!, /target: Launch Runbook \(identity\)/);
  assert.match(section!, /rollback owners/);
});

test("entity retrieval keeps distinct native-only entries that share a title", async () => {
  const { workspaceDir, config, storage } = await buildHarness("engram-entity-native-duplicate", {
    nativeKnowledge: {
      enabled: true,
      includeFiles: ["docs/one/launch-runbook.md", "docs/two/launch-runbook.md"],
      maxChunkChars: 400,
      maxResults: 5,
      maxChars: 1600,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
  });
  await mkdir(path.join(workspaceDir, "docs", "one"), { recursive: true });
  await mkdir(path.join(workspaceDir, "docs", "two"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "docs", "one", "launch-runbook.md"),
    "# Launch Runbook\n\nFirst runbook owns rollback drills.\n",
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "docs", "two", "launch-runbook.md"),
    "# Launch Runbook\n\nSecond runbook owns launch communications.\n",
    "utf-8",
  );

  await buildSection(config, storage, "Tell me about Launch Runbook");

  const index = JSON.parse(await readFile(path.join(config.memoryDir, "state", "entity-mention-index.json"), "utf-8"));
  const launchRunbookEntries = index.entities.filter((entry: { name: string }) => entry.name === "Launch Runbook");
  assert.equal(launchRunbookEntries.length, 2);
});

test("entity retrieval prefers recent user mentions over assistant-only mentions for pronoun follow-ups", async () => {
  const { config, storage } = await buildHarness("engram-entity-followup-user-priority");
  await writeEntity(
    storage,
    "Alice Example",
    "person",
    ["Alice Example owns the release checklist."],
    "Alice Example owns the release checklist.",
  );
  await writeEntity(
    storage,
    "Bob Example",
    "person",
    ["Bob Example owns the on-call rotation."],
    "Bob Example owns the on-call rotation.",
  );

  const transcriptEntries: TranscriptEntry[] = [
    {
      timestamp: "2026-03-09T10:00:00.000Z",
      role: "user",
      content: "What do we know about Alice Example?",
      sessionKey: "user:test:entity-followup-priority",
      turnId: "turn-1",
    },
    {
      timestamp: "2026-03-09T10:00:05.000Z",
      role: "assistant",
      content: "Bob Example probably owns the release checklist.",
      sessionKey: "user:test:entity-followup-priority",
      turnId: "turn-2",
    },
  ];

  const section = await buildSection(config, storage, "What happened with her?", transcriptEntries);

  assert.ok(section);
  assert.match(section!, /target: Alice Example \(person\)/);
  assert.doesNotMatch(section!, /target: Bob Example \(person\)/);
});

test("orchestrator injects entity retrieval before the knowledge index", async () => {
  const { memoryDir, workspaceDir } = await buildHarness("engram-entity-orchestrator");
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
  });
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  await writeEntity(
    storage,
    "Jordan Merge",
    "person",
    ["Jordan Merge owns the review automation."],
    "Jordan Merge maintains review automation for Engram.",
    ["Jordan"],
  );

  const orchestrator = new Orchestrator(cfg);
  const context = await (orchestrator as any).recallInternal("Who is Jordan?", "user:test:entity-order");

  const entityIndex = context.indexOf("## entity_answer_hints");
  const knowledgeIndex = context.indexOf("## Knowledge Index");
  assert.equal(entityIndex >= 0, true);
  assert.equal(knowledgeIndex >= 0, true);
  assert.equal(entityIndex < knowledgeIndex, true);
});

test("orchestrator preserves zero-limit semantics for entity retrieval", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-entity-zero-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-entity-zero-workspace-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    entityRetrievalMaxHints: 0,
  });
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  await writeEntity(
    storage,
    "Zero Limit",
    "person",
    ["Zero Limit owns the guardrail test."],
    "Zero Limit exists only to verify limit semantics.",
  );

  const orchestrator = new Orchestrator(cfg);
  const context = await (orchestrator as any).recallInternal("Who is Zero Limit?", "user:test:entity-zero");

  assert.equal(context.includes("## entity_answer_hints"), false);
  assert.equal(context.includes("## Knowledge Index"), true);
});
