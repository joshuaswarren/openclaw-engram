import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("remnic CLI source wires the new bench command and keeps benchmark as an alias", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /\| "bench"/);
  assert.match(source, /case "bench": \{/);
  assert.match(source, /case "benchmark": \{/);
  assert.match(source, /await cmdBench\(rest\);/);
  assert.match(source, /remnic bench <list\|run>/);
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

  assert.match(source, /--dataset-dir <path>\s+Override the benchmark dataset directory for full runs/);
  assert.match(source, /function readBenchOptionValue\(argv: string\[\], flag: string\)/);
  assert.match(source, /requires a value\./);
  assert.match(source, /datasetDir: datasetDir \? path\.resolve\(expandTilde\(datasetDir\)\) : undefined/);
  assert.match(source, /resolveBenchDatasetDir\(\s*benchmarkId,\s*parsed\.quick,\s*parsed\.datasetDir/s);
  assert.match(source, /full benchmark runs for "\$\{benchmarkId\}" require dataset files/);
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

  assert.match(source, /function parseBenchActionArgs\(argv: string\[\]\)/);
  assert.match(source, /const benchAction = parseBenchActionArgs\(rest\);/);
  assert.match(source, /await cmdLegacyBenchmark\(parsed\.action,\s*benchAction\.args,\s*parsed\.json\);/);
  assert.doesNotMatch(source, /await cmdLegacyBenchmark\(parsed\.action,\s*rest\.slice\(1\),\s*parsed\.json\);/);
});
