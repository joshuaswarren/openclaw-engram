import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("@remnic/bench publishes compiled entrypoints instead of raw source paths", async () => {
  const pkg = JSON.parse(
    await readFile("packages/bench/package.json", "utf8"),
  ) as {
    main?: string;
    types?: string;
    exports?: { ".": { import?: string; types?: string } };
    files?: string[];
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.main, "./dist/index.js");
  assert.equal(pkg.types, "./dist/index.d.ts");
  assert.equal(pkg.exports?.["."]?.import, "./dist/index.js");
  assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts");
  // `baselines/` ships with the package so consumers can compare their
  // ablation runs against the committed reference artifacts (issue #567 PR 2).
  assert.deepEqual(pkg.files, ["dist", "baselines"]);
  assert.equal(pkg.scripts?.build, "tsup --config tsup.config.ts");
});

test("bench reporter resolves the repo root package.json for Remnic version lookup", async () => {
  const reporterSource = await readFile("packages/bench/src/reporter.ts", "utf8");
  const packageJsonPath = path.resolve("packages/bench/dist", "../../../package.json");
  const pkg = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as { version?: string };

  assert.match(reporterSource, /path\.resolve\(import\.meta\.dirname, "\.\.\/\.\.\/\.\.\/package\.json"\)/);
  assert.equal(typeof pkg.version, "string");
});

test("legacy adapter benchmark types use explicit Legacy* names to avoid colliding with phase-1 result types", async () => {
  const source = await readFile("packages/bench/src/adapters/types.ts", "utf8");

  assert.match(source, /export interface LegacyBenchmarkMeta/);
  assert.match(source, /export interface LegacyBenchmarkResult/);
  assert.match(source, /export interface LegacyBenchmarkRunner/);
  assert.doesNotMatch(source, /export interface BenchmarkMeta/);
  assert.doesNotMatch(source, /export interface BenchmarkResult/);
  assert.doesNotMatch(source, /export interface BenchmarkRunner/);
});

test("@remnic/bench index exports the phase-2 stats helpers", async () => {
  const source = await readFile("packages/bench/src/index.ts", "utf8");

  assert.match(source, /bootstrapMeanConfidenceInterval/);
  assert.match(source, /pairedDeltaConfidenceInterval/);
  assert.match(source, /cohensD/);
  assert.match(source, /interpretEffectSize/);
  assert.match(source, /compareResults/);
  assert.match(source, /defaultBenchmarkBaselineDir/);
  assert.match(source, /loadBenchmarkBaseline/);
  assert.match(source, /listBenchmarkBaselines/);
  assert.match(source, /loadBenchmarkResult/);
  assert.match(source, /listBenchmarkResults/);
  assert.match(source, /renderBenchmarkResultExport/);
  assert.match(source, /buildBenchmarkPublishFeed/);
  assert.match(source, /defaultBenchmarkPublishPath/);
  assert.match(source, /resolveBenchmarkResultReference/);
  assert.match(source, /saveBenchmarkBaseline/);
  assert.match(source, /writeBenchmarkPublishFeed/);
  assert.match(source, /buildBenchmarkRunSeeds/);
  assert.match(source, /orchestrateBenchmarkRuns/);
  assert.match(source, /resolveBenchmarkRunCount/);
});

test("@remnic/bench index exports the custom benchmark loader and runner", async () => {
  const source = await readFile("packages/bench/src/index.ts", "utf8");

  assert.match(source, /CustomBenchmarkScoring/);
  assert.match(source, /loadCustomBenchmarkFile/);
  assert.match(source, /parseCustomBenchmark/);
  assert.match(source, /runCustomBenchmarkFile/);
});

test("@remnic/bench index exports provider factory and discovery helpers", async () => {
  const source = await readFile("packages/bench/src/index.ts", "utf8");

  assert.match(source, /createAnthropicProvider/);
  assert.match(source, /createLiteLlmProvider/);
  assert.match(source, /createOllamaProvider/);
  assert.match(source, /createProvider/);
  assert.match(source, /discoverAllProviders/);
});
