import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("remnic CLI source wires the new bench command and keeps benchmark as an alias", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /\| "bench"/);
  assert.match(source, /case "bench": \{/);
  assert.match(source, /case "benchmark": \{/);
  assert.match(source, /await cmdBench\(rest\);/);
  assert.match(source, /remnic bench <list\|run\|compare\|results\|baseline\|export>/);
  assert.match(source, /benchmark is kept as a compatibility alias/i);
});

test("bench surface publishes the phase-1 benchmark catalog and quick-run fallback mapping", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  for (const benchmarkId of ["ama-bench", "memory-arena", "amemgym", "longmemeval", "locomo"]) {
    assert.match(source, new RegExp(`id: "${benchmarkId}"`));
  }
  assert.match(source, /args\.push\("--lightweight", "--limit", "1"\)/);
  assert.match(source, /args\.push\("--dataset-dir", parsed\.datasetDir\)/);
  assert.match(source, /Use 'remnic bench list' to see available\./);
});

test("workspace scripts expose bench list, bench run, and a quick smoke path", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const helper = await readFile("scripts/run-bench-cli.mjs", "utf8");

  assert.equal(pkg.scripts?.["bench:list"], "node scripts/run-bench-cli.mjs list");
  assert.equal(pkg.scripts?.["bench:run"], "node scripts/run-bench-cli.mjs run");
  assert.equal(pkg.scripts?.["bench:compare"], "node scripts/run-bench-cli.mjs compare");
  assert.equal(pkg.scripts?.["bench:quick"], "node scripts/run-bench-cli.mjs run --quick longmemeval");

  assert.match(helper, /packages", "remnic-core", "dist", "index\.js"/);
  assert.match(helper, /packages", "bench", "dist", "index\.js"/);
  assert.match(helper, /\["--filter", "@remnic\/core", "build"\]/);
  assert.match(helper, /\["--filter", "@remnic\/bench", "build"\]/);
  assert.match(helper, /\["exec", "tsx", "packages\/remnic-cli\/src\/index\.ts", "bench"/);
});

test("CLI README documents bench list and quick-run examples", async () => {
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(readme, /remnic bench list/);
  assert.match(readme, /remnic bench run --quick longmemeval/);
  assert.match(readme, /--dataset-dir ~\/datasets\/longmemeval/);
  assert.match(readme, /remnic bench compare base-run candidate-run/);
  assert.match(readme, /remnic benchmark run --quick longmemeval/);
  assert.match(readme, /bundled smoke fixture/i);
  assert.match(readme, /full runs need a real benchmark dataset/i);
});

test("CLI uses package-owned adapters for migrated benchmark runs", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /createLightweightAdapter/);
  assert.match(source, /createRemnicAdapter/);
  assert.match(source, /async function runBenchViaPackage/);
  assert.match(source, /try \{\s*benchModule = await import\("@remnic\/bench"\)/s);
  assert.match(source, /\} catch \{\s*return false;\s*\}/s);
  assert.doesNotMatch(source, /evals\/adapter\/engram-adapter\.ts/);
});

test("--all selection resolves to runnable package benchmarks when package metadata is available", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /async function resolveAllBenchmarks\(\)/);
  assert.match(source, /packageBenchmarks\s*\n\s*\.filter\(\(entry\) => entry\.runnerAvailable\)/s);
  assert.match(source, /const selectedBenchmarks = parsed\.all\s+\? await resolveAllBenchmarks\(\)/s);
  assert.match(source, /async function resolveKnownBenchmarkIds\(\): Promise<Set<string>>/);
  assert.match(source, /const knownBenchmarkIds = await resolveKnownBenchmarkIds\(\);/);
  assert.match(source, /selectedBenchmarks\.filter\(\(benchmarkId\) => !knownBenchmarkIds\.has\(benchmarkId\)\)/);
  assert.match(source, /no runnable benchmarks are available for --all in this install/i);
});

test("bench CLI validates and resolves explicit dataset overrides for full package runs", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(source, /--dataset-dir <path>\s+Override the benchmark dataset directory for full runs/);
  assert.match(source, /from "\.\/bench-args\.js";/);
  assert.match(parserSource, /function readBenchOptionValue\(argv: string\[\], flag: string\)/);
  assert.match(parserSource, /function collectBenchmarks\(argv: string\[\]\): string\[\]/);
  assert.match(parserSource, /const benchmarkArgs = action === "baseline" \? args\.slice\(1\) : args;/);
  assert.match(parserSource, /const benchmarks = collectBenchmarks\(benchmarkArgs\);/);
  assert.match(parserSource, /requires a value\./);
  assert.match(parserSource, /arg === "--dataset-dir"[\s\S]*arg === "--results-dir"[\s\S]*arg === "--baselines-dir"[\s\S]*arg === "--threshold"[\s\S]*arg === "--format"[\s\S]*arg === "--output"/);
  assert.match(parserSource, /datasetDir: datasetDir \? path\.resolve\(expandTilde\(datasetDir\)\) : undefined/);
  assert.match(source, /resolveBenchDatasetDir\(\s*benchmarkId,\s*parsed\.quick,\s*parsed\.datasetDir/s);
  assert.match(source, /const outputDir = resolveBenchOutputDir\(\);/);
  assert.match(source, /const datasetDir = resolveBenchDatasetDir\(/);
  assert.match(source, /if \(!parsed\.quick && !datasetDir\) \{\s*throw new Error\(/s);
  assert.match(source, /full benchmark runs for "\$\{benchmarkId\}" require dataset files/);
  assert.match(source, /const system = await createAdapter\(\);/);
});

test("bench compare routes through stored package results with threshold and results-dir options", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(source, /compareResults,/);
  assert.match(source, /loadBenchmarkResult,/);
  assert.match(source, /resolveBenchmarkResultReference,/);
  assert.match(source, /async function compareBenchPackageResults\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /if \(parsed\.action === "compare"\) \{\s*await compareBenchPackageResults\(parsed\);/s);
  assert.match(source, /compare requires exactly two stored result references/i);
  assert.match(source, /parsed\.resultsDir \?\? resolveBenchOutputDir\(\)/);
  assert.match(source, /compareResults\(\s*baseline,\s*candidate,\s*parsed\.threshold \?\? 0\.05/s);
  assert.match(source, /benchmark mismatch: \$\{baseline\.meta\.benchmark\} vs \$\{candidate\.meta\.benchmark\}/);
  assert.match(parserSource, /export type BenchAction =[\s\S]*"results"[\s\S]*"baseline"[\s\S]*"export"[\s\S]*"check"[\s\S]*"report";/);
  assert.match(parserSource, /const resultsDir = readBenchOptionValue\(args, "--results-dir"\);/);
  assert.match(parserSource, /const thresholdRaw = readBenchOptionValue\(args, "--threshold"\);/);
  assert.match(parserSource, /ERROR: --threshold must be a non-negative number\./);
  assert.match(parserSource, /resultsDir: resultsDir \? path\.resolve\(expandTilde\(resultsDir\)\) : undefined/);
  assert.match(parserSource, /threshold,/);
});

test("bench results, baseline, and export route through the stored package results helpers", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(source, /defaultBenchmarkBaselineDir,/);
  assert.match(source, /listBenchmarkBaselines,/);
  assert.match(source, /loadBenchmarkBaseline,/);
  assert.match(source, /listBenchmarkResults,/);
  assert.match(source, /renderBenchmarkResultExport,/);
  assert.match(source, /saveBenchmarkBaseline,/);
  assert.match(source, /async function showBenchPackageResults\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /async function manageBenchBaselines\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /async function exportBenchPackageResult\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /if \(parsed\.action === "results"\) \{\s*await showBenchPackageResults\(parsed\);/s);
  assert.match(source, /if \(parsed\.action === "baseline"\) \{\s*await manageBenchBaselines\(parsed\);/s);
  assert.match(source, /if \(parsed\.action === "export"\) \{\s*await exportBenchPackageResult\(parsed\);/s);
  assert.match(source, /baseline save <name> \[run\]/);
  assert.match(source, /bench export <run> --format <json\|csv>/);
  assert.match(source, /const baselineDir = parsed\.baselinesDir \?\? resolveBenchBaselineDir\(\)/);
  assert.match(source, /const rendered = renderBenchmarkResultExport\(result, parsed\.format\);/);
  assert.match(parserSource, /export type BenchBaselineAction = "save" \| "list";/);
  assert.match(parserSource, /export type BenchExportFormat = "json" \| "csv";/);
  assert.match(parserSource, /const baselinesDir = readBenchOptionValue\(args, "--baselines-dir"\);/);
  assert.match(parserSource, /const formatRaw = readBenchOptionValue\(args, "--format"\);/);
  assert.match(parserSource, /const output = readBenchOptionValue\(args, "--output"\);/);
  assert.match(parserSource, /detail: args\.includes\("--detail"\),/);
  assert.match(parserSource, /baselinesDir: baselinesDir \? path\.resolve\(expandTilde\(baselinesDir\)\) : undefined/);
  assert.match(parserSource, /output: output \? path\.resolve\(expandTilde\(output\)\) : undefined/);
});

test("parseBenchArgs excludes --dataset-dir values from benchmark ids", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs([
    "run",
    "longmemeval",
    "--dataset-dir",
    "~/datasets/longmemeval",
  ]);
  assert.deepEqual(parsed.benchmarks, ["longmemeval"]);
  assert.match(parsed.datasetDir ?? "", /datasets[\/\\]longmemeval$/);

  const optionFirst = parseBenchArgs([
    "run",
    "--dataset-dir",
    "/tmp/bench-dataset",
    "longmemeval",
  ]);
  assert.deepEqual(optionFirst.benchmarks, ["longmemeval"]);
  assert.equal(optionFirst.datasetDir, "/tmp/bench-dataset");
});

test("parseBenchArgs supports compare-specific results-dir and threshold options", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs([
    "compare",
    "base-run",
    "candidate-run",
    "--results-dir",
    "~/bench-results",
    "--threshold",
    "0.2",
  ]);

  assert.equal(parsed.action, "compare");
  assert.deepEqual(parsed.benchmarks, ["base-run", "candidate-run"]);
  assert.match(parsed.resultsDir ?? "", /bench-results$/);
  assert.equal(parsed.threshold, 0.2);
});

test("parseBenchArgs supports results, baseline, and export surfaces", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const resultsArgs = parseBenchArgs([
    "results",
    "candidate-run",
    "--detail",
    "--results-dir",
    "~/bench-results",
  ]);
  assert.equal(resultsArgs.action, "results");
  assert.deepEqual(resultsArgs.benchmarks, ["candidate-run"]);
  assert.equal(resultsArgs.detail, true);
  assert.match(resultsArgs.resultsDir ?? "", /bench-results$/);

  const baselineArgs = parseBenchArgs([
    "baseline",
    "save",
    "main",
    "candidate-run",
    "--baselines-dir",
    "~/bench-baselines",
  ]);
  assert.equal(baselineArgs.action, "baseline");
  assert.equal(baselineArgs.baselineAction, "save");
  assert.deepEqual(baselineArgs.benchmarks, ["main", "candidate-run"]);
  assert.match(baselineArgs.baselinesDir ?? "", /bench-baselines$/);

  const exportArgs = parseBenchArgs([
    "export",
    "candidate-run",
    "--format",
    "csv",
    "--output",
    "./candidate.csv",
  ]);
  assert.equal(exportArgs.action, "export");
  assert.equal(exportArgs.format, "csv");
  assert.match(exportArgs.output ?? "", /candidate\.csv$/);
});

test("CLI uses the package BenchmarkDefinition contract instead of a local benchmark metadata clone", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /type BenchmarkDefinition,\s*\n\s*\} from "@remnic\/bench";/s);
  assert.match(source, /async function loadBenchDefinitionsFromPackage\(\): Promise<BenchmarkDefinition\[\] \| undefined>/);
  assert.match(source, /listBenchmarks\?: \(\) => BenchmarkDefinition\[\];/);
  assert.doesNotMatch(source, /interface PackageBenchDefinition/);
  assert.doesNotMatch(source, /listBenchmarks\?: \(\) => Promise<.*BenchmarkDefinition\[\].*\|/s);
});

test("legacy benchmark check/report reuse the normalized action args instead of re-slicing rest", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /parseBenchActionArgs,\s*\n\s*parseBenchArgs,/s);
  assert.match(source, /const benchAction = parseBenchActionArgs\(rest\);/);
  assert.match(source, /await cmdLegacyBenchmark\(parsed\.action,\s*benchAction\.args,\s*parsed\.json\);/);
  assert.doesNotMatch(source, /await cmdLegacyBenchmark\(parsed\.action,\s*rest\.slice\(1\),\s*parsed\.json\);/);
});
