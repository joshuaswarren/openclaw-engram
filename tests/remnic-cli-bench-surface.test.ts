import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("remnic CLI source wires the new bench command and keeps benchmark as an alias", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /\| "bench"/);
  assert.match(source, /case "bench": \{/);
  assert.match(source, /case "benchmark": \{/);
  assert.match(source, /await cmdBench\(rest\);/);
  assert.match(source, /remnic bench <list\|run\|compare\|results\|baseline\|export\|publish\|ui\|providers>/);
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
  assert.match(readme, /remnic bench publish --target remnic-ai/);
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
  assert.match(source, /--custom <path>\s+Run a YAML-defined custom benchmark file/);
  assert.match(source, /from "\.\/bench-args\.js";/);
  assert.match(source, /async function runCustomBenchViaPackage\(parsed: ParsedBenchArgs\): Promise<boolean>/);
  assert.match(parserSource, /function readBenchOptionValue\(argv: string\[\], flag: string\)/);
  assert.match(parserSource, /function collectBenchmarks\(argv: string\[\]\): string\[\]/);
  assert.match(parserSource, /const benchmarkArgs = action === "baseline" \|\| action === "providers" \? args\.slice\(1\) : args;/);
  assert.match(parserSource, /const benchmarks = collectBenchmarks\(benchmarkArgs\);/);
  assert.match(parserSource, /requires a value\./);
  assert.match(parserSource, /arg === "--dataset-dir"[\s\S]*arg === "--results-dir"[\s\S]*arg === "--baselines-dir"[\s\S]*arg === "--threshold"[\s\S]*arg === "--custom"[\s\S]*arg === "--format"[\s\S]*arg === "--output"/);
  assert.match(parserSource, /datasetDir: datasetDir \? path\.resolve\(expandTilde\(datasetDir\)\) : undefined/);
  assert.match(parserSource, /custom: customRaw \? path\.resolve\(expandTilde\(customRaw\)\) : undefined/);
  assert.match(source, /resolveBenchDatasetDir\(\s*benchmarkId,\s*parsed\.quick,\s*parsed\.datasetDir/s);
  assert.match(source, /if \(parsed\.custom\) \{/);
  assert.match(source, /const outputDir = resolveBenchOutputDir\(\);/);
  assert.match(source, /const datasetDir = resolveBenchDatasetDir\(/);
  assert.match(source, /if \(!parsed\.quick && !datasetDir\) \{\s*throw new Error\(/s);
  assert.match(source, /full benchmark runs for "\$\{benchmarkId\}" require dataset files/);
  assert.match(source, /const runtime = await resolvePackageBenchRuntime\(/);
  assert.match(source, /const system = await createAdapter\(runtime\.adapterOptions\);/);
});

test("parseBenchArgs supports custom benchmark files without counting them as benchmark ids", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs(["run", "--custom", "~/benchmarks/custom.yaml"]);

  assert.match(parsed.custom ?? "", /benchmarks[\/\\]custom\.yaml$/);
  assert.deepEqual(parsed.benchmarks, []);
});

test("bench CLI exposes runtime profile and provider-backed run surfaces", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(source, /--runtime-profile <baseline\|real\|openclaw-chain>/);
  assert.match(source, /--matrix <profiles>/);
  assert.match(source, /--remnic-config <path>/);
  assert.match(source, /--openclaw-config <path>/);
  assert.match(source, /--model-source <plugin\|gateway>/);
  assert.match(source, /--gateway-agent-id <id>/);
  assert.match(source, /--fast-gateway-agent-id <id>/);
  assert.match(source, /--system-provider <openai\|anthropic\|ollama\|litellm>/);
  assert.match(source, /--system-model <model>/);
  assert.match(source, /--judge-provider <openai\|anthropic\|ollama\|litellm>/);
  assert.match(source, /--judge-model <model>/);
  assert.match(source, /remnic bench run --quick longmemeval --runtime-profile baseline/);
  assert.match(source, /remnic bench run longmemeval --runtime-profile real --remnic-config/);
  assert.match(source, /remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config/);
  assert.match(source, /remnic bench run longmemeval --runtime-profile real --system-provider openai --system-model/);
  assert.match(source, /remnic bench run longmemeval --matrix baseline,real,openclaw-chain/);

  assert.match(parserSource, /export type BenchRuntimeProfile = "baseline" \| "real" \| "openclaw-chain";/);
  assert.match(parserSource, /runtimeProfile\?: BenchRuntimeProfile;/);
  assert.match(parserSource, /matrixProfiles\?: BenchRuntimeProfile\[];/);
  assert.match(parserSource, /systemProvider\?: BuiltInProvider;/);
  assert.match(parserSource, /judgeProvider\?: BuiltInProvider;/);
  assert.match(parserSource, /const runtimeProfileRaw = readBenchOptionValue\(args, "--runtime-profile"\);/);
  assert.match(parserSource, /const matrixRaw = readBenchOptionValue\(args, "--matrix"\);/);
  assert.match(parserSource, /const remnicConfigRaw = readBenchOptionValue\(args, "--remnic-config"\);/);
  assert.match(parserSource, /const openclawConfigRaw = readBenchOptionValue\(args, "--openclaw-config"\);/);
  assert.match(parserSource, /const systemProviderRaw = readBenchOptionValue\(args, "--system-provider"\);/);
  assert.match(parserSource, /const judgeProviderRaw = readBenchOptionValue\(args, "--judge-provider"\);/);
  assert.match(readme, /remnic bench run --quick longmemeval --runtime-profile baseline/);
  assert.match(readme, /remnic bench run longmemeval --runtime-profile real --remnic-config/);
  assert.match(readme, /remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config/);
});

test("parseBenchArgs supports runtime profiles, provider-backed runs, and matrix mode", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs([
    "run",
    "longmemeval",
    "--runtime-profile",
    "openclaw-chain",
    "--openclaw-config",
    "~/.openclaw/openclaw.json",
    "--model-source",
    "gateway",
    "--gateway-agent-id",
    "memory-primary",
    "--fast-gateway-agent-id",
    "memory-fast",
    "--system-provider",
    "openai",
    "--system-model",
    "gpt-5.4-mini",
    "--system-base-url",
    "http://localhost:4000/v1",
    "--judge-provider",
    "anthropic",
    "--judge-model",
    "claude-sonnet-4-5",
    "--judge-base-url",
    "http://localhost:4100",
    "--matrix",
    "baseline,real,openclaw-chain",
  ]);

  assert.equal(parsed.action, "run");
  assert.deepEqual(parsed.benchmarks, ["longmemeval"]);
  assert.equal(parsed.runtimeProfile, "openclaw-chain");
  assert.deepEqual(parsed.matrixProfiles, ["baseline", "real", "openclaw-chain"]);
  assert.equal(parsed.modelSource, "gateway");
  assert.equal(parsed.gatewayAgentId, "memory-primary");
  assert.equal(parsed.fastGatewayAgentId, "memory-fast");
  assert.equal(parsed.systemProvider, "openai");
  assert.equal(parsed.systemModel, "gpt-5.4-mini");
  assert.equal(parsed.judgeProvider, "anthropic");
  assert.equal(parsed.judgeModel, "claude-sonnet-4-5");
  assert.match(parsed.openclawConfigPath ?? "", /openclaw\.json$/);
  assert.match(parsed.systemBaseUrl ?? "", /4000\/v1$/);
  assert.match(parsed.judgeBaseUrl ?? "", /4100$/);
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
  assert.match(parserSource, /export type BenchAction =[\s\S]*"results"[\s\S]*"baseline"[\s\S]*"export"[\s\S]*"publish"[\s\S]*"check"[\s\S]*"report";/);
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
  assert.match(source, /bench export <run> --format <json\|csv\|html>/);
  assert.match(source, /const baselineDir = parsed\.baselinesDir \?\? resolveBenchBaselineDir\(\)/);
  assert.match(source, /const rendered = renderBenchmarkResultExport\(result, parsed\.format\);/);
  assert.match(source, /ERROR: export requires --format json, csv, or html\./);
  assert.match(source, /printBenchPackageSummary\(result, summary\.path, "Stored result"\);/);
  assert.match(parserSource, /export type BenchBaselineAction = "save" \| "list";/);
  assert.match(parserSource, /export type BenchExportFormat = "json" \| "csv" \| "html";/);
  assert.match(parserSource, /const baselinesDir = readBenchOptionValue\(args, "--baselines-dir"\);/);
  assert.match(parserSource, /const formatRaw = readBenchOptionValue\(args, "--format"\);/);
  assert.match(parserSource, /const output = readBenchOptionValue\(args, "--output"\);/);
  assert.match(parserSource, /ERROR: --format must be "json", "csv", or "html"\./);
  assert.match(parserSource, /detail: args\.includes\("--detail"\),/);
  assert.match(parserSource, /baselinesDir: baselinesDir \? path\.resolve\(expandTilde\(baselinesDir\)\) : undefined/);
  assert.match(parserSource, /output: output \? path\.resolve\(expandTilde\(output\)\) : undefined/);
});

test("bench providers discovery is exposed as a package-backed CLI surface", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(source, /discoverAllProviders,/);
  assert.match(source, /Usage: remnic bench <list\|run\|compare\|results\|baseline\|export\|publish\|ui\|providers>/);
  assert.match(source, /remnic bench providers discover/);
  assert.match(source, /async function discoverBenchProviders\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /providers discover does not accept positional arguments/);
  assert.match(source, /if \(parsed\.action === "providers"\) \{\s*await discoverBenchProviders\(parsed\);/s);
  assert.match(parserSource, /export type BenchAction =[\s\S]*"providers"[\s\S]*"check"[\s\S]*"report";/);
  assert.match(parserSource, /export type BenchProviderAction = "discover";/);
  assert.match(parserSource, /providerAction\?: BenchProviderAction;/);
  assert.match(parserSource, /first === "providers"/);
  assert.match(parserSource, /const providerAction =[\s\S]*args\[0\] === "discover"/);
  assert.match(readme, /remnic bench providers discover/);
});

test("bench surface retains local UI compatibility alongside providers discovery", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(parserSource, /\| "ui"/);
  assert.match(parserSource, /first === "ui"/);
  assert.match(source, /ui\s+Launch the local benchmark overview UI/);
  assert.match(source, /if \(parsed\.action === "ui"\) \{\s*await launchBenchUi\(parsed\.resultsDir \?\? resolveBenchOutputDir\(\)\);\s*return;\s*\}/s);
});

test("parseBenchArgs supports the providers discovery surface", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs(["providers", "discover", "--json"]);

  assert.equal(parsed.action, "providers");
  assert.equal(parsed.providerAction, "discover");
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.benchmarks, []);
});

test("parseBenchArgs preserves unexpected trailing providers args for CLI validation", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs(["providers", "discover", "foo"]);

  assert.equal(parsed.action, "providers");
  assert.equal(parsed.providerAction, "discover");
  assert.deepEqual(parsed.benchmarks, ["foo"]);
});

test("bench providers discover rejects unexpected trailing positional args", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..");
  const cliEntry = pathToFileURL(join(repoRoot, "packages/remnic-cli/src/index.ts")).href;

  interface StubHandle {
    cleanup: () => void;
  }

  // Stub a workspace package's dist entry if it doesn't exist, so the
  // CLI's dynamic imports resolve even when the monorepo hasn't been
  // built in CI. Each stub tracks what it created so we restore the
  // pre-test filesystem state in the finally block.
  const stubWorkspacePackage = (
    packageName: string,
    moduleBody: string,
  ): StubHandle => {
    const linkRoot = join(repoRoot, "packages/remnic-cli/node_modules", packageName);
    const moduleRoot = existsSync(linkRoot) ? realpathSync(linkRoot) : linkRoot;
    const distDir = join(moduleRoot, "dist");
    const entry = join(distDir, "index.js");
    const packageJson = join(moduleRoot, "package.json");
    const needsEntry = !existsSync(entry);
    const createdLinkRoot = !existsSync(linkRoot);
    const createdPackageJson = needsEntry && !existsSync(packageJson);
    const createdDistDir = needsEntry && !existsSync(distDir);

    if (needsEntry) {
      mkdirSync(distDir, { recursive: true });
      if (createdPackageJson) {
        writeFileSync(
          packageJson,
          JSON.stringify({
            name: packageName,
            type: "module",
            exports: { ".": "./dist/index.js" },
          }),
        );
      }
      writeFileSync(entry, moduleBody);
    }

    return {
      cleanup: () => {
        if (!needsEntry) return;
        rmSync(entry, { force: true });
        if (createdDistDir) rmSync(distDir, { recursive: true, force: true });
        if (createdPackageJson) rmSync(packageJson, { force: true });
        if (createdLinkRoot) rmSync(moduleRoot, { recursive: true, force: true });
      },
    };
  };

  const stubs: StubHandle[] = [
    stubWorkspacePackage(
      "@remnic/bench",
      `
export function compareResults() {}
export async function buildBenchmarkPublishFeed() { return { target: "remnic-ai", generatedAt: new Date(0).toISOString(), benchmarks: [] }; }
export function checkRegression() { return null; }
export function defaultBenchmarkBaselineDir() { return ""; }
export function defaultBenchmarkPublishPath() { return ""; }
export async function discoverAllProviders() { return []; }
export function getBenchmarkLowerIsBetter() { return new Set(); }
export async function listBenchmarkBaselines() { return []; }
export async function listBenchmarkResults() { return []; }
export async function loadBenchmarkBaseline() { return null; }
export async function runBenchSuite() { return null; }
export async function runExplain() { return null; }
export async function loadBaseline() { return null; }
export async function saveBaseline() { return null; }
export async function loadBenchmarkResult() { return null; }
export function renderBenchmarkResultExport() { return ""; }
export async function resolveBenchmarkResultReference() { return null; }
export async function saveBenchmarkBaseline() { return null; }
export async function writeBenchmarkPublishFeed() { return ""; }
`,
    ),
    // The CLI lazily imports these optional adapter packages to
    // register themselves with the core registry. If their dist
    // builds are absent in CI, the import throws and crashes the
    // command under test — a no-op stub is enough to make the
    // registration path succeed.
    stubWorkspacePackage(
      "@remnic/export-weclone",
      `
export const wecloneExportAdapter = { name: "weclone", fileExtension: "json", formatRecords: () => "" };
export function ensureWecloneExportAdapterRegistered() {}
export function synthesizeTrainingPairs() { return []; }
export function sweepPii(input) { return input; }
`,
    ),
    stubWorkspacePackage(
      "@remnic/import-weclone",
      `
export const wecloneImportAdapter = { name: "weclone", parse: async () => ({ turns: [], metadata: {} }) };
export function ensureWecloneImportAdapterRegistered() {}
`,
    ),
  ];

  const originalExit = process.exit;
  const exitCalls: number[] = [];

  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`PROCESS_EXIT:${code ?? 0}`);
  }) as typeof process.exit;

  try {
    const { main } = await import(`${cliEntry}?test=${Date.now()}`);
    await assert.rejects(
      () => main(["bench", "providers", "discover", "foo"]),
      /PROCESS_EXIT:1/,
    );
    assert.deepEqual(exitCalls, [1]);
  } finally {
    process.exit = originalExit;
    for (const stub of stubs) stub.cleanup();
  }
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
    "html",
    "--output",
    "./report.html",
  ]);
  assert.equal(exportArgs.action, "export");
  assert.equal(exportArgs.format, "html");
  assert.match(exportArgs.output ?? "", /report\.html$/);

  const publishArgs = parseBenchArgs([
    "publish",
    "--target",
    "remnic-ai",
    "--output",
    "./benchmarks.json",
  ]);
  assert.equal(publishArgs.action, "publish");
  assert.equal(publishArgs.target, "remnic-ai");
  assert.deepEqual(publishArgs.benchmarks, []);
  assert.match(publishArgs.output ?? "", /benchmarks\.json$/);
});

test("bench publish routes through the stored package feed helpers", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(source, /buildBenchmarkPublishFeed,/);
  assert.match(source, /defaultBenchmarkPublishPath,/);
  assert.match(source, /writeBenchmarkPublishFeed,/);
  assert.match(source, /async function publishBenchPackageResults\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /publish requires --target remnic-ai/);
  assert.match(source, /if \(feed\.benchmarks\.length === 0\) \{/);
  assert.match(source, /no publishable benchmark results found in \$\{resultsDir\}/);
  assert.match(source, /remnic-ai requires stored full runs for published benchmarks/);
  assert.match(source, /Published \$\{feed\.benchmarks\.length\} benchmark entries for \$\{parsed\.target\} to \$\{writtenPath\}/);
  assert.match(source, /if \(parsed\.action === "publish"\) \{\s*await publishBenchPackageResults\(parsed\);/s);
  assert.match(parserSource, /export type BenchPublishTarget = "remnic-ai";/);
  assert.match(parserSource, /arg === "--target"/);
  assert.match(parserSource, /const targetRaw = readBenchOptionValue\(args, "--target"\);/);
  assert.match(parserSource, /ERROR: --target must be "remnic-ai"\./);
  assert.match(parserSource, /target,\s*\n\s*\};/s);
});

test("parseBenchArgs rejects unknown bench publish targets", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  assert.throws(
    () => parseBenchArgs(["publish", "--target", "somewhere-else"]),
    /ERROR: --target must be "remnic-ai"\./,
  );
});

test("CLI uses the package BenchmarkDefinition contract instead of a local benchmark metadata clone", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /type BenchmarkDefinition,/);
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
