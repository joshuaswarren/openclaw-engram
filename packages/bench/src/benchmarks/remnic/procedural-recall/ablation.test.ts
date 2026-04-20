/**
 * Tests for the procedural recall ablation harness (issue #567 PR 1/5).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fixtureToAblationScenarios,
  loadAblationFixture,
  runProceduralAblation,
  runProceduralAblationCli,
  type ProceduralAblationScenario,
} from "./ablation.ts";
import { PROCEDURAL_RECALL_E2E_FIXTURE } from "./fixture.ts";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Canonical ablation fixture for tests: prompts that look like task
 * initiation and DO have matching procedures should recall when procedural is
 * on (and not when it's off). A distractor prompt ("What is our usual…")
 * should reject on both sides.
 */
const ABLATION_FIXTURE: ProceduralAblationScenario[] = [
  {
    id: "deploy-gateway",
    prompt: "Let's deploy the gateway to production today",
    procedurePreamble: "When you deploy the gateway",
    procedureSteps: [
      { order: 1, intent: "Run deploy checks for production gateway" },
      { order: 2, intent: "Push the release tag" },
    ],
    procedureTags: ["deploy", "gateway"],
    expectMatch: true,
  },
  {
    id: "open-pr",
    prompt: "Open a PR for the regression fix",
    procedurePreamble: "PR opening procedure",
    procedureSteps: [
      { order: 1, intent: "Open a pull request for the regression fix" },
      { order: 2, intent: "Link the issue" },
    ],
    procedureTags: ["pr", "regression"],
    expectMatch: true,
  },
  {
    id: "no-task-init",
    prompt: "What is our usual process for production deploys?",
    procedurePreamble: "Production deploy runbook",
    procedureSteps: [
      { order: 1, intent: "Notify on-call" },
      { order: 2, intent: "Apply change window" },
    ],
    procedureTags: ["deploy", "runbook"],
    expectMatch: false,
  },
];

test("runProceduralAblation: lift >= 0 on matching-positive fixture", async () => {
  const artifact = await runProceduralAblation({
    scenarios: ABLATION_FIXTURE,
    random: mulberry32(42),
    bootstrapIterations: 200,
  });

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.fixture.scenarioCount, ABLATION_FIXTURE.length);
  assert.equal(artifact.perCase.length, ABLATION_FIXTURE.length);
  assert.ok(artifact.onScore >= artifact.offScore, "on should not regress");
  assert.ok(artifact.lift >= 0, `lift was ${artifact.lift}`);
  // The positive-match scenarios should recall when procedural is on.
  const onMatched = artifact.perCase
    .filter((c) => c.expectMatch === true)
    .every((c) => c.onMatched === true);
  const offNotMatched = artifact.perCase.every((c) => c.offMatched === false);
  assert.equal(onMatched, true, "on should recall every positive scenario");
  assert.equal(
    offNotMatched,
    true,
    "off should never recall (gate is disabled)",
  );
  // Confidence interval should be well-formed.
  assert.ok(
    artifact.confidenceInterval.lower <= artifact.confidenceInterval.upper,
    "CI bounds must be ordered",
  );
  assert.equal(artifact.confidenceInterval.level, 0.95);
});

test("runProceduralAblation: deterministic CI under seeded RNG", async () => {
  const a = await runProceduralAblation({
    scenarios: ABLATION_FIXTURE,
    random: mulberry32(1),
    bootstrapIterations: 200,
  });
  const b = await runProceduralAblation({
    scenarios: ABLATION_FIXTURE,
    random: mulberry32(1),
    bootstrapIterations: 200,
  });
  assert.equal(a.onScore, b.onScore);
  assert.equal(a.offScore, b.offScore);
  assert.equal(a.lift, b.lift);
  assert.equal(a.confidenceInterval.lower, b.confidenceInterval.lower);
  assert.equal(a.confidenceInterval.upper, b.confidenceInterval.upper);
});

test("runProceduralAblation: rejects empty scenarios", async () => {
  await assert.rejects(
    () =>
      runProceduralAblation({
        scenarios: [],
        random: mulberry32(1),
        bootstrapIterations: 100,
      }),
    /non-empty scenarios/,
  );
});

test("fixtureToAblationScenarios maps from the existing e2e fixture", () => {
  const mapped = fixtureToAblationScenarios(PROCEDURAL_RECALL_E2E_FIXTURE);
  assert.equal(mapped.length, PROCEDURAL_RECALL_E2E_FIXTURE.length);
  for (const row of mapped) {
    assert.equal(typeof row.expectMatch, "boolean");
    assert.equal(typeof row.prompt, "string");
    assert.ok(Array.isArray(row.procedureSteps));
  }
});

test("loadAblationFixture parses a valid JSON array", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-ablation-fixture-"));
  try {
    const p = path.join(dir, "fixture.json");
    await writeFile(p, JSON.stringify(ABLATION_FIXTURE), "utf8");
    const loaded = await loadAblationFixture(p);
    assert.equal(loaded.length, ABLATION_FIXTURE.length);
    assert.equal(loaded[0]!.id, "deploy-gateway");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAblationFixture parses { scenarios: [...] } wrapper", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-ablation-fixture-"));
  try {
    const p = path.join(dir, "fixture.json");
    await writeFile(
      p,
      JSON.stringify({ scenarios: ABLATION_FIXTURE }),
      "utf8",
    );
    const loaded = await loadAblationFixture(p);
    assert.equal(loaded.length, ABLATION_FIXTURE.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAblationFixture rejects invalid input", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-ablation-fixture-"));
  try {
    const p = path.join(dir, "fixture.json");
    await writeFile(p, "null", "utf8");
    await assert.rejects(() => loadAblationFixture(p), /must be a JSON object/);

    await writeFile(p, "{}", "utf8");
    await assert.rejects(() => loadAblationFixture(p), /scenarios.*array/);

    await writeFile(p, "[{}]", "utf8");
    await assert.rejects(() => loadAblationFixture(p), /missing one of/);

    await writeFile(p, "not-json", "utf8");
    await assert.rejects(() => loadAblationFixture(p), /parse fixture JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runProceduralAblationCli writes an artifact to --out", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-ablation-cli-"));
  try {
    const fixturePath = path.join(dir, "fixture.json");
    const outPath = path.join(dir, "artifact.json");
    await writeFile(fixturePath, JSON.stringify(ABLATION_FIXTURE), "utf8");

    const artifact = await runProceduralAblationCli({
      fixturePath,
      outPath,
      random: mulberry32(7),
      bootstrapIterations: 100,
    });
    assert.equal(artifact.fixture.path, fixturePath);
    assert.equal(artifact.fixture.scenarioCount, ABLATION_FIXTURE.length);

    const disk = JSON.parse(await readFile(outPath, "utf8")) as {
      schemaVersion: number;
      onScore: number;
      offScore: number;
      lift: number;
    };
    assert.equal(disk.schemaVersion, 1);
    assert.equal(disk.onScore, artifact.onScore);
    assert.equal(disk.offScore, artifact.offScore);
    assert.equal(disk.lift, artifact.lift);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runProceduralAblationCli falls back to built-in fixture when --fixture omitted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-ablation-cli-"));
  try {
    const outPath = path.join(dir, "artifact.json");
    const artifact = await runProceduralAblationCli({
      fixturePath: null,
      outPath,
      random: mulberry32(7),
      bootstrapIterations: 100,
    });
    assert.equal(artifact.fixture.path, null);
    assert.equal(
      artifact.fixture.scenarioCount,
      PROCEDURAL_RECALL_E2E_FIXTURE.length,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
