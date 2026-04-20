import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "bench", "bench-smoke.ts");
const committedBaseline = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "bench-smoke",
  "baseline.json",
);

function runSmoke(args: readonly string[], cwd: string = repoRoot): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      scriptPath,
      ...args,
    ],
    {
      cwd,
      env: process.env,
      encoding: "utf8",
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("bench-smoke passes against the committed baseline", () => {
  const { code, stdout } = runSmoke([]);
  assert.equal(
    code,
    0,
    `bench-smoke exited non-zero:\n${stdout}`,
  );
  assert.match(stdout, /all metrics within tolerance/);
});

test("bench-smoke rejects invalid --seed", () => {
  const { code, stderr } = runSmoke(["--seed", "not-a-number"]);
  assert.equal(code, 1);
  assert.match(stderr, /--seed must be a non-negative integer/);
});

test("bench-smoke rejects --seed with no value", () => {
  const { code, stderr } = runSmoke(["--seed"]);
  assert.equal(code, 1);
  assert.match(stderr, /--seed requires an integer argument/);
});

test("bench-smoke rejects unknown flags", () => {
  const { code, stderr } = runSmoke(["--nope"]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown argument: --nope/);
});

test("bench-smoke regression detection fires when baseline metrics are raised", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-smoke-tamper-"));
  try {
    const raw = await readFile(committedBaseline, "utf8");
    const baseline = JSON.parse(raw) as {
      benchmarks: Record<string, { metrics: Record<string, number> }>;
    };
    // Raise every metric to 0.99 so any current run scores well below it.
    for (const benchmarkId of Object.keys(baseline.benchmarks)) {
      const metrics = baseline.benchmarks[benchmarkId]!.metrics;
      for (const key of Object.keys(metrics)) {
        metrics[key] = 0.99;
      }
    }
    const tamperedPath = path.join(dir, "baseline.json");
    await writeFile(tamperedPath, JSON.stringify(baseline, null, 2), "utf8");
    const { code, stderr } = runSmoke(["--baseline", tamperedPath]);
    assert.equal(code, 1);
    assert.match(stderr, /REGRESSION/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bench-smoke fails when a baseline metric disappears from the current run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-smoke-missing-metric-"));
  try {
    const raw = await readFile(committedBaseline, "utf8");
    const baseline = JSON.parse(raw) as {
      benchmarks: Record<string, { metrics: Record<string, number> }>;
    };
    // Inject a phantom metric into the baseline that the current run
    // will never produce. This simulates a runner-side regression that
    // stops emitting a metric.
    for (const benchmarkId of Object.keys(baseline.benchmarks)) {
      baseline.benchmarks[benchmarkId]!.metrics["phantom_metric"] = 0.5;
    }
    const tamperedPath = path.join(dir, "baseline.json");
    await writeFile(tamperedPath, JSON.stringify(baseline, null, 2), "utf8");
    const { code, stderr, stdout } = runSmoke(["--baseline", tamperedPath]);
    assert.equal(code, 1);
    assert.match(stderr, /MISSING metric/);
    assert.match(stderr, /phantom_metric/);
    assert.match(stdout, /MISSING \(metric absent from current run\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bench-smoke fails when an entire baseline benchmark disappears", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-smoke-missing-bench-"));
  try {
    const raw = await readFile(committedBaseline, "utf8");
    const baseline = JSON.parse(raw) as {
      benchmarks: Record<string, { metrics: Record<string, number> }>;
    };
    // Inject a phantom benchmark entirely.
    baseline.benchmarks["phantom_bench"] = { metrics: { score: 0.5 } };
    const tamperedPath = path.join(dir, "baseline.json");
    await writeFile(tamperedPath, JSON.stringify(baseline, null, 2), "utf8");
    const { code, stderr } = runSmoke(["--baseline", tamperedPath]);
    assert.equal(code, 1);
    assert.match(stderr, /phantom_bench/);
    assert.match(stderr, /entire benchmark missing from current run/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bench-smoke rejects option-like tokens as flag values", () => {
  const { code, stderr } = runSmoke(["--baseline", "--update-baseline"]);
  assert.equal(code, 1);
  assert.match(stderr, /option-like token "--update-baseline"/);
});

test("bench-smoke --update-baseline writes a stable file (no timestamp)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-smoke-update-"));
  try {
    const outPath = path.join(dir, "baseline.json");
    const first = runSmoke(["--baseline", outPath, "--update-baseline"]);
    assert.equal(first.code, 0);
    const firstRaw = await readFile(outPath, "utf8");

    // Re-run immediately; committed baseline must be byte-identical since
    // the smoke runner is deterministic and the baseline carries no
    // `generatedAt` timestamp.
    const second = runSmoke(["--baseline", outPath, "--update-baseline"]);
    assert.equal(second.code, 0);
    const secondRaw = await readFile(outPath, "utf8");
    assert.equal(firstRaw, secondRaw);

    const parsed = JSON.parse(firstRaw) as {
      schemaVersion: number;
      benchmarks: Record<string, unknown>;
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(parsed.benchmarks.longmemeval);
    assert.ok(parsed.benchmarks.locomo);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(parsed, "generatedAt"),
      "baseline must not carry a generatedAt timestamp",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
