/**
 * Tests for reinforcement recall boost (issue #687 PR 3/4).
 *
 * Covers:
 *   - Boost applied when feature is on and memory has reinforcement_count
 *   - No boost when feature flag is off (default)
 *   - Boost capped at reinforcementRecallBoostMax
 *   - Boost surfaced in X-ray scoreDecomposition.reinforcementBoost
 *   - Config parsing: defaults, clamping, invalid-value rejection
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import {
  buildXraySnapshot,
  type RecallXrayResult,
} from "../src/recall-xray.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

async function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeOrchestrator(
  memoryDir: string,
  overrides: Record<string, unknown> = {},
): Promise<Orchestrator> {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    // Disable recency/access/importance boosts so score arithmetic is deterministic
    // and tests can assert exact score values.
    recencyWeight: 0,
    boostAccessCount: false,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    intentRoutingEnabled: false,
    queryAwareIndexingEnabled: false,
    lifecyclePolicyEnabled: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

/** Write a minimal memory markdown file with frontmatter. */
async function writeMemory(
  dir: string,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const fm: Record<string, unknown> = {
    id,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    category: "fact",
    status: "active",
    ...extra,
  };
  // Use bare unquoted YAML scalars so the parser returns the correct JS types.
  // Quoting a string in YAML keeps the quotes as part of the value, which makes
  // Date parsing produce NaN for timestamp fields.
  const yamlLines = Object.entries(fm).map(([k, v]) => {
    if (typeof v === "string") return `${k}: ${v}`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  const content = `---\n${yamlLines.join("\n")}\n---\n\ntest memory ${id}\n`;
  const filePath = path.join(dir, `${id}.md`);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

// ─── Config parsing ───────────────────────────────────────────────────────────

test("reinforcementRecallBoostEnabled defaults to false", () => {
  const config = parseConfig({ openaiApiKey: "sk-test" });
  assert.strictEqual(config.reinforcementRecallBoostEnabled, false);
});

test("reinforcementRecallBoostWeight defaults to 0.05", () => {
  const config = parseConfig({ openaiApiKey: "sk-test" });
  assert.strictEqual(config.reinforcementRecallBoostWeight, 0.05);
});

test("reinforcementRecallBoostMax defaults to 0.3", () => {
  const config = parseConfig({ openaiApiKey: "sk-test" });
  assert.strictEqual(config.reinforcementRecallBoostMax, 0.3);
});

test("reinforcementRecallBoostEnabled coerces string 'true'", () => {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    reinforcementRecallBoostEnabled: "true",
  });
  assert.strictEqual(config.reinforcementRecallBoostEnabled, true);
});

test("reinforcementRecallBoostWeight accepts valid [0,1] value", () => {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    reinforcementRecallBoostWeight: 0.1,
  });
  assert.strictEqual(config.reinforcementRecallBoostWeight, 0.1);
});

test("reinforcementRecallBoostWeight accepts 0 (disable scaling)", () => {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    reinforcementRecallBoostWeight: 0,
  });
  assert.strictEqual(config.reinforcementRecallBoostWeight, 0);
});

test("reinforcementRecallBoostMax accepts valid [0,1] value", () => {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    reinforcementRecallBoostMax: 0.5,
  });
  assert.strictEqual(config.reinforcementRecallBoostMax, 0.5);
});

test("reinforcementRecallBoostWeight rejects out-of-range value", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        reinforcementRecallBoostWeight: 1.5,
      }),
    /reinforcementRecallBoostWeight/,
  );
});

test("reinforcementRecallBoostMax rejects negative value", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        reinforcementRecallBoostMax: -0.1,
      }),
    /reinforcementRecallBoostMax/,
  );
});

// ─── boostSearchResults unit-level tests ─────────────────────────────────────

test("no boost when reinforcementRecallBoostEnabled is false (default)", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-off-");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeMemory(path.join(memoryDir, "facts"), "fact-001", {
    reinforcement_count: 5,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: false,
  });
  (orchestrator as any).initPromise = null;

  // Access the private method directly for unit testing.
  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-001",
        path: path.join(memoryDir, "facts", "fact-001.md"),
        snippet: "test",
        score: 0.5,
      },
    ],
    ["global"],
  );

  assert.equal(result.length, 1);
  assert.strictEqual(result[0].score, 0.5);
  assert.strictEqual(result[0].explain?.reinforcementBoost, undefined);
});

test("boost applied when feature on and memory has reinforcement_count", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-on-");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeMemory(path.join(memoryDir, "facts"), "fact-002", {
    reinforcement_count: 3,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 1.0,
  });
  (orchestrator as any).initPromise = null;

  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-002",
        path: path.join(memoryDir, "facts", "fact-002.md"),
        snippet: "test",
        score: 0.5,
      },
    ],
    ["global"],
  );

  assert.equal(result.length, 1);
  // Expected boost = min(3 * 0.1, 1.0) = 0.3
  assert.ok(
    Math.abs(result[0].score - 0.8) < 1e-9,
    `expected score ≈ 0.8 but got ${result[0].score}`,
  );
  assert.ok(
    Math.abs((result[0].explain?.reinforcementBoost ?? 0) - 0.3) < 1e-9,
    `expected reinforcementBoost ≈ 0.3 but got ${result[0].explain?.reinforcementBoost}`,
  );
});

test("boost capped at reinforcementRecallBoostMax", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-cap-");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeMemory(path.join(memoryDir, "facts"), "fact-003", {
    reinforcement_count: 100,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 0.25,
  });
  (orchestrator as any).initPromise = null;

  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-003",
        path: path.join(memoryDir, "facts", "fact-003.md"),
        snippet: "test",
        score: 0.5,
      },
    ],
    ["global"],
  );

  assert.equal(result.length, 1);
  // Uncapped would be 100 * 0.1 = 10.0 but max is 0.25.
  // Expected score = 0.5 + 0.25 = 0.75.
  assert.ok(
    Math.abs(result[0].score - 0.75) < 1e-9,
    `expected score ≈ 0.75 but got ${result[0].score}`,
  );
  assert.ok(
    Math.abs((result[0].explain?.reinforcementBoost ?? 0) - 0.25) < 1e-9,
    `expected reinforcementBoost ≈ 0.25 but got ${result[0].explain?.reinforcementBoost}`,
  );
});

test("no boost for memory without reinforcement_count", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-no-count-");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  // No reinforcement_count field
  await writeMemory(path.join(memoryDir, "facts"), "fact-004", {});

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 0.3,
  });
  (orchestrator as any).initPromise = null;

  const baseScore = 0.6;
  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-004",
        path: path.join(memoryDir, "facts", "fact-004.md"),
        snippet: "test",
        score: baseScore,
      },
    ],
    ["global"],
  );

  assert.equal(result.length, 1);
  // No reinforcement boost; score may differ only due to recency/lifecycle adjustments.
  // The key assertion: reinforcementBoost is undefined on explain.
  assert.strictEqual(result[0].explain?.reinforcementBoost, undefined);
});

// ─── X-ray surface ────────────────────────────────────────────────────────────

test("X-ray scoreDecomposition carries reinforcementBoost when boost applied", () => {
  // This tests the pure RecallXrayResult / buildXraySnapshot path directly —
  // the orchestrator plumbing is integration-tested in recall-xray-capture.test.ts.
  const result: RecallXrayResult = {
    memoryId: "fact-005",
    path: "/memories/fact-005.md",
    servedBy: "hybrid",
    scoreDecomposition: {
      final: 0.75,
      reinforcementBoost: 0.25,
    },
    admittedBy: ["namespace-scope", "status-active"],
  };

  const snapshot = buildXraySnapshot({
    query: "test query",
    results: [result],
    now: () => 1_700_000_000_000,
    snapshotIdGenerator: () => "test-snap-id",
  });

  assert.equal(snapshot.results.length, 1);
  assert.strictEqual(
    snapshot.results[0].scoreDecomposition.reinforcementBoost,
    0.25,
  );
  assert.strictEqual(snapshot.results[0].scoreDecomposition.final, 0.75);
});

test("X-ray scoreDecomposition omits reinforcementBoost when zero or absent", () => {
  const result: RecallXrayResult = {
    memoryId: "fact-006",
    path: "/memories/fact-006.md",
    servedBy: "hybrid",
    scoreDecomposition: {
      final: 0.6,
    },
    admittedBy: ["namespace-scope"],
  };

  const snapshot = buildXraySnapshot({
    query: "test query",
    results: [result],
    now: () => 1_700_000_000_000,
    snapshotIdGenerator: () => "test-snap-id-2",
  });

  assert.equal(snapshot.results.length, 1);
  assert.strictEqual(
    snapshot.results[0].scoreDecomposition.reinforcementBoost,
    undefined,
  );
});

test("cloneResult in buildXraySnapshot drops reinforcementBoost=0", () => {
  const result: RecallXrayResult = {
    memoryId: "fact-007",
    path: "/memories/fact-007.md",
    servedBy: "direct-answer",
    scoreDecomposition: {
      final: 0.9,
      reinforcementBoost: 0, // zero should be dropped
    },
    admittedBy: [],
  };

  const snapshot = buildXraySnapshot({
    query: "test",
    results: [result],
    now: () => 1_700_000_000_000,
    snapshotIdGenerator: () => "test-snap-id-3",
  });

  assert.equal(snapshot.results.length, 1);
  // Zero boost must not appear in the snapshot.
  assert.strictEqual(
    snapshot.results[0].scoreDecomposition.reinforcementBoost,
    undefined,
  );
});
