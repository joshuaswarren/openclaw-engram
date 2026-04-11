import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import {
  hasCitation,
  parseCitation,
  stripCitation,
} from "../packages/remnic-core/src/source-attribution.ts";
import type { ExtractionResult } from "../src/types.js";

/**
 * Issue #369 — Orchestrator-level source attribution end-to-end.
 *
 * These tests call persistExtraction directly (the same entry point used by
 * the buffer extraction path and proactive extraction) and verify that:
 *   - The default configuration is a no-op (backwards compat).
 *   - Enabling `inlineSourceAttributionEnabled` causes each persisted fact
 *     to carry a compact provenance tag inside the fact body.
 *   - Custom format templates are honored.
 *   - Round-trip from write through readAllMemories preserves the tag, so
 *     recall injection sees the citation verbatim.
 */

function makeFact(content: string): {
  content: string;
  category: "fact";
  tags: string[];
  confidence: number;
} {
  return { content, category: "fact", tags: [], confidence: 0.9 };
}

async function makeOrchestrator(
  configOverrides: Record<string, unknown> = {},
): Promise<{ orchestrator: any; storage: any; memoryDir: string }> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-source-attribution-"),
  );
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    ...configOverrides,
  });
  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();
  return { orchestrator, storage, memoryDir };
}

test("persistExtraction is a no-op by default — no inline citation is injected", async () => {
  const { orchestrator, storage } = await makeOrchestrator();

  const factBody =
    "The production database is hosted on Postgres 16 and uses port 5432.";
  const result: ExtractionResult = {
    facts: [makeFact(factBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
    { sessionKey: "agent:planner:main", principal: "planner" },
  );
  assert.equal(persistedIds.length, 1);

  const memories = await storage.readAllMemories();
  const written = memories.find(
    (m: any) => m.frontmatter.id === persistedIds[0],
  );
  assert.ok(written);
  assert.equal(hasCitation(written.content), false);
  // Raw body must be untouched for existing downstream consumers.
  assert.ok(written.content.includes(factBody));
});

test("persistExtraction injects the inline citation when the flag is enabled", async () => {
  const { orchestrator, storage } = await makeOrchestrator({
    inlineSourceAttributionEnabled: true,
  });

  const factBody =
    "The production database is hosted on Postgres 16 and uses port 5432.";
  const result: ExtractionResult = {
    facts: [makeFact(factBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
    { sessionKey: "agent:planner:main", principal: "planner" },
  );
  assert.equal(persistedIds.length, 1);

  const memories = await storage.readAllMemories();
  const written = memories.find(
    (m: any) => m.frontmatter.id === persistedIds[0],
  );
  assert.ok(written, "persisted memory must be readable");

  assert.ok(
    hasCitation(written.content),
    `expected citation in stored content, got: ${written.content}`,
  );
  const parsed = parseCitation(written.content);
  assert.ok(parsed);
  assert.equal(parsed!.agent, "planner");
  assert.equal(parsed!.session, "main");
  assert.ok(parsed!.ts && parsed!.ts.length > 0);

  // Downstream consumers can recover the raw fact body.
  assert.equal(stripCitation(written.content), factBody);
});

test("persistExtraction honors a custom inline citation format template", async () => {
  const { orchestrator, storage } = await makeOrchestrator({
    inlineSourceAttributionEnabled: true,
    inlineSourceAttributionFormat: "[src:{agent}/{sessionId}@{date}]",
  });

  const factBody = "The cache invalidation interval is 30 seconds.";
  const result: ExtractionResult = {
    facts: [makeFact(factBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
    { sessionKey: "agent:scout:alpha", principal: "scout" },
  );
  assert.equal(persistedIds.length, 1);

  const memories = await storage.readAllMemories();
  const written = memories.find(
    (m: any) => m.frontmatter.id === persistedIds[0],
  );
  assert.ok(written);

  // Custom template uses a different bracket syntax, which the default
  // parser does not recognise — but we can still verify the text contains
  // the expected markers and that the raw body is unchanged.
  assert.ok(
    /\[src:scout\/alpha@\d{4}-\d{2}-\d{2}\]/.test(written.content),
    `expected custom citation template, got: ${written.content}`,
  );
  assert.ok(written.content.startsWith(factBody));
});

test("persistExtraction does not double-inject a citation on facts that already carry one", async () => {
  const { orchestrator, storage } = await makeOrchestrator({
    inlineSourceAttributionEnabled: true,
  });

  // Simulate a fact that already carries a citation (e.g., relayed from an
  // upstream system or a legacy migrated fact). attachCitation must refuse
  // to overwrite existing provenance.
  const factBody =
    "The auth service rotates tokens every 24 hours. [Source: agent=upstream, session=legacy, ts=2025-01-01T00:00:00Z]";
  const result: ExtractionResult = {
    facts: [makeFact(factBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
    { sessionKey: "agent:planner:main", principal: "planner" },
  );
  assert.equal(persistedIds.length, 1);

  const memories = await storage.readAllMemories();
  const written = memories.find(
    (m: any) => m.frontmatter.id === persistedIds[0],
  );
  assert.ok(written);

  const parsed = parseCitation(written.content);
  assert.ok(parsed);
  assert.equal(parsed!.agent, "upstream");
  assert.equal(parsed!.session, "legacy");
  assert.equal(parsed!.ts, "2025-01-01T00:00:00Z");
});
