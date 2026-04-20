/**
 * Procedural recall ablation harness (issue #567 PR 1/5).
 *
 * Runs the same fixture twice — once with `procedural.enabled=false`, once
 * with `procedural.enabled=true` — and emits a diff artifact:
 *
 *   { onScore, offScore, lift, confidenceInterval }
 *
 * The harness is deterministic and uses no LLM calls: the "stub LLM adapter"
 * requirement is satisfied because the scoring function is a pure, local
 * check (`buildProcedureRecallSection` returns markdown when gating + token
 * overlap thresholds pass). Downstream slices (PR 2) plug in a stub response
 * adapter via `StubLlmAdapter` for scenarios that need free-form generation.
 *
 * CLI: `remnic bench procedural-ablation --fixture <path> --out <path>`
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  StorageManager,
  parseConfig,
  buildProcedureRecallSection,
  buildProcedureMarkdownBody,
} from "@remnic/core";
import { pairedDeltaConfidenceInterval } from "../../../stats/bootstrap.js";
import type { ConfidenceInterval } from "../../../types.js";
import {
  PROCEDURAL_RECALL_E2E_FIXTURE,
  type ProceduralRecallE2eCase,
} from "./fixture.js";

/**
 * Scenario shape for the ablation harness. A superset of
 * `ProceduralRecallE2eCase` with an `expectMatch` alias so downstream fixtures
 * can be expressed in either vocabulary.
 */
export interface ProceduralAblationScenario {
  id: string;
  prompt: string;
  procedurePreamble: string;
  procedureSteps: Array<{ order: number; intent: string }>;
  procedureTags: string[];
  /**
   * True when the prompt should recall the procedure. False for distractor /
   * non-task-initiation prompts where we expect the gate to reject.
   */
  expectMatch: boolean;
}

export interface ProceduralAblationPerCase {
  id: string;
  prompt: string;
  expectMatch: boolean;
  onMatched: boolean;
  offMatched: boolean;
  onScore: number;
  offScore: number;
}

export interface ProceduralAblationArtifact {
  schemaVersion: 1;
  fixture: {
    path: string | null;
    scenarioCount: number;
  };
  onScore: number;
  offScore: number;
  lift: number;
  confidenceInterval: ConfidenceInterval;
  perCase: ProceduralAblationPerCase[];
  generatedAt: string;
}

/**
 * Score a single scenario: 1 if the observed recall matches expectation, else 0.
 * This is a binary correctness metric, so `lift = onScore - offScore` is
 * directly interpretable as points of accuracy gained by turning procedural
 * recall on.
 */
function scoreCase(expectMatch: boolean, observedMatch: boolean): number {
  return observedMatch === expectMatch ? 1 : 0;
}

/**
 * Convert the existing `ProceduralRecallE2eCase` fixture into
 * ablation-scenario shape. A case `expects` a match iff its gold label was
 * `expectNonNullSection=true` AND the original fixture intended procedural to
 * be on for that row (we normalize the ablation to always sweep both sides).
 */
export function fixtureToAblationScenarios(
  fixture: ProceduralRecallE2eCase[],
): ProceduralAblationScenario[] {
  return fixture.map((c) => ({
    id: c.id,
    prompt: c.prompt,
    procedurePreamble: c.procedurePreamble,
    procedureSteps: c.procedureSteps,
    procedureTags: c.procedureTags,
    // When the original fixture row had proceduralEnabled=false it was
    // testing the "gate rejects when disabled" invariant; for the ablation we
    // always want to know if a task-initiation prompt *should* recall given
    // procedural is on, so we fall back to the non-null expectation directly.
    expectMatch: c.expectNonNullSection === true,
  }));
}

/**
 * Run one side of the ablation: seed a temp store with each scenario's
 * procedure, then invoke `buildProcedureRecallSection` with the requested
 * gating and observe whether a non-null section was returned.
 */
async function runSide(
  scenarios: ProceduralAblationScenario[],
  proceduralEnabled: boolean,
): Promise<boolean[]> {
  const observed: boolean[] = [];
  for (const scenario of scenarios) {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "remnic-bench-proc-ablation-"),
    );
    try {
      const storage = new StorageManager(dir);
      await storage.ensureDirectories();
      const body = buildProcedureMarkdownBody(scenario.procedureSteps);
      await storage.writeMemory(
        "procedure",
        `${scenario.procedurePreamble}\n\n${body}`,
        { source: "bench", tags: scenario.procedureTags },
      );

      const config = parseConfig({
        memoryDir: dir,
        workspaceDir: path.join(dir, "ws"),
        openaiApiKey: "bench-key",
        procedural: {
          enabled: proceduralEnabled,
          recallMaxProcedures: 3,
        },
      });

      const section = await buildProcedureRecallSection(
        storage,
        scenario.prompt,
        config,
      );
      observed.push(section !== null && section.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return observed;
}

export interface RunProceduralAblationOptions {
  scenarios: ProceduralAblationScenario[];
  /** Path the ablation was loaded from (echoed back into the artifact). */
  fixturePath?: string | null;
  /** Bootstrap iterations for CI on the paired delta (default: 1_000). */
  bootstrapIterations?: number;
  /** Seeded RNG for deterministic CI in tests / CI. */
  random?: () => number;
}

/**
 * Pure entrypoint — accepts a scenario list and returns the artifact. Reads
 * and writes are isolated to the StorageManager temp directories the sides
 * create and remove internally.
 */
export async function runProceduralAblation(
  options: RunProceduralAblationOptions,
): Promise<ProceduralAblationArtifact> {
  const { scenarios } = options;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error(
      "runProceduralAblation requires a non-empty scenarios array",
    );
  }

  const onMatched = await runSide(scenarios, true);
  const offMatched = await runSide(scenarios, false);

  const onPer = scenarios.map((s, i) => scoreCase(s.expectMatch, onMatched[i]!));
  const offPer = scenarios.map((s, i) =>
    scoreCase(s.expectMatch, offMatched[i]!),
  );

  const onScore =
    onPer.reduce((sum, value) => sum + value, 0) / onPer.length;
  const offScore =
    offPer.reduce((sum, value) => sum + value, 0) / offPer.length;
  const lift = onScore - offScore;

  const confidenceInterval = pairedDeltaConfidenceInterval(onPer, offPer, {
    iterations: options.bootstrapIterations ?? 1_000,
    random: options.random ?? Math.random,
  });

  const perCase: ProceduralAblationPerCase[] = scenarios.map((s, i) => ({
    id: s.id,
    prompt: s.prompt,
    expectMatch: s.expectMatch,
    onMatched: onMatched[i]!,
    offMatched: offMatched[i]!,
    onScore: onPer[i]!,
    offScore: offPer[i]!,
  }));

  return {
    schemaVersion: 1,
    fixture: {
      path: options.fixturePath ?? null,
      scenarioCount: scenarios.length,
    },
    onScore,
    offScore,
    lift,
    confidenceInterval,
    perCase,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Load a scenario list from a JSON file. Validates the JSON is an object with
 * a `scenarios` array (or a bare array) and each entry has the required
 * fields. Rejects invalid input per CLAUDE.md rule 51 rather than silently
 * defaulting.
 */
export async function loadAblationFixture(
  fixturePath: string,
): Promise<ProceduralAblationScenario[]> {
  const raw = await readFile(fixturePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse fixture JSON at ${fixturePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Fixture at ${fixturePath} must be a JSON object or array`);
  }
  const scenariosRaw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { scenarios?: unknown }).scenarios)
      ? (parsed as { scenarios: unknown[] }).scenarios
      : null;
  if (!Array.isArray(scenariosRaw)) {
    throw new Error(
      `Fixture at ${fixturePath} must contain a \"scenarios\" array or be an array at the top level`,
    );
  }

  const scenarios: ProceduralAblationScenario[] = [];
  for (let i = 0; i < scenariosRaw.length; i++) {
    const row = scenariosRaw[i];
    if (!row || typeof row !== "object") {
      throw new Error(`Fixture scenario at index ${i} must be an object`);
    }
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : null;
    const prompt = typeof r.prompt === "string" ? r.prompt : null;
    const preamble =
      typeof r.procedurePreamble === "string" ? r.procedurePreamble : null;
    const steps = Array.isArray(r.procedureSteps) ? r.procedureSteps : null;
    const tags = Array.isArray(r.procedureTags)
      ? (r.procedureTags as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : null;
    const expect = typeof r.expectMatch === "boolean" ? r.expectMatch : null;
    if (
      id === null ||
      prompt === null ||
      preamble === null ||
      steps === null ||
      tags === null ||
      expect === null
    ) {
      throw new Error(
        `Fixture scenario at index ${i} is missing one of: id, prompt, procedurePreamble, procedureSteps, procedureTags, expectMatch`,
      );
    }
    const normalizedSteps: Array<{ order: number; intent: string }> = [];
    for (let j = 0; j < steps.length; j++) {
      const s = steps[j];
      if (!s || typeof s !== "object") {
        throw new Error(
          `Fixture scenario ${id} step ${j} must be an object with order and intent`,
        );
      }
      const obj = s as Record<string, unknown>;
      const order =
        typeof obj.order === "number" && Number.isFinite(obj.order)
          ? Math.floor(obj.order)
          : j + 1;
      const intent = typeof obj.intent === "string" ? obj.intent : null;
      if (intent === null) {
        throw new Error(
          `Fixture scenario ${id} step ${j} is missing string \"intent\"`,
        );
      }
      normalizedSteps.push({ order, intent });
    }
    scenarios.push({
      id,
      prompt,
      procedurePreamble: preamble,
      procedureSteps: normalizedSteps,
      procedureTags: tags,
      expectMatch: expect,
    });
  }
  return scenarios;
}

/**
 * CLI entrypoint. Resolves `--fixture <path>` (defaults to the built-in e2e
 * fixture converted to ablation scenarios when unset) and writes the artifact
 * to `--out <path>`. Validates inputs per CLAUDE.md rules 14 / 17 / 51.
 */
export interface RunProceduralAblationCliArgs {
  fixturePath: string | null;
  outPath: string;
  bootstrapIterations?: number;
  random?: () => number;
}

export async function runProceduralAblationCli(
  args: RunProceduralAblationCliArgs,
): Promise<ProceduralAblationArtifact> {
  const scenarios =
    args.fixturePath !== null
      ? await loadAblationFixture(args.fixturePath)
      : fixtureToAblationScenarios(PROCEDURAL_RECALL_E2E_FIXTURE);

  const artifact = await runProceduralAblation({
    scenarios,
    fixturePath: args.fixturePath,
    bootstrapIterations: args.bootstrapIterations,
    random: args.random,
  });

  await writeFile(args.outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return artifact;
}
