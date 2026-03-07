import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  runBenchmarkImportCliCommand,
  runBenchmarkStatusCliCommand,
  runBenchmarkValidateCliCommand,
} from "../src/cli.js";

async function writeManifest(filePath: string, benchmarkId = "ama-memory"): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        benchmarkId,
        title: "AMA-style benchmark pack",
        tags: ["trajectory", "objective-state"],
        sourceLinks: ["https://arxiv.org/abs/2602.22769"],
        cases: [
          {
            id: "case-1",
            prompt: "Recover the last changed system state and explain the next action.",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

test("benchmark-validate accepts a manifest JSON file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-validate-file-"));
  const manifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(manifestPath);

  const summary = await runBenchmarkValidateCliCommand({ path: manifestPath });

  assert.equal(summary.manifestPath, manifestPath);
  assert.equal(summary.benchmarkId, "ama-memory");
  assert.equal(summary.totalCases, 1);
  assert.deepEqual(summary.tags, ["trajectory", "objective-state"]);
});

test("benchmark-validate accepts a directory pack with root manifest.json", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-validate-dir-"));
  const packDir = path.join(tmpDir, "ama-memory-pack");
  await mkdir(packDir, { recursive: true });
  await writeManifest(path.join(packDir, "manifest.json"));

  const summary = await runBenchmarkValidateCliCommand({ path: packDir });

  assert.equal(summary.sourcePath, packDir);
  assert.equal(summary.manifestPath, path.join(packDir, "manifest.json"));
  assert.equal(summary.benchmarkId, "ama-memory");
});

test("benchmark-import copies a manifest file into the eval benchmark store", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-import-file-"));
  const manifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(manifestPath);

  const result = await runBenchmarkImportCliCommand({
    path: manifestPath,
    memoryDir: tmpDir,
  });

  const importedManifest = JSON.parse(await readFile(path.join(result.targetDir, "manifest.json"), "utf8")) as {
    benchmarkId: string;
  };

  assert.equal(result.targetDir, path.join(tmpDir, "state", "evals", "benchmarks", "ama-memory"));
  assert.equal(result.overwritten, false);
  assert.equal(importedManifest.benchmarkId, "ama-memory");
});

test("benchmark-import preserves extra files when importing a directory pack", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-import-dir-"));
  const packDir = path.join(tmpDir, "pack");
  await mkdir(path.join(packDir, "fixtures"), { recursive: true });
  await writeManifest(path.join(packDir, "manifest.json"));
  await writeFile(path.join(packDir, "fixtures", "notes.md"), "# notes\n", "utf8");
  await writeFile(path.join(packDir, "fixtures", "case-data.json"), JSON.stringify({ fixture: true }, null, 2), "utf8");

  const result = await runBenchmarkImportCliCommand({
    path: packDir,
    memoryDir: tmpDir,
  });

  const fixture = await readFile(path.join(result.targetDir, "fixtures", "notes.md"), "utf8");
  const status = await runBenchmarkStatusCliCommand({
    memoryDir: tmpDir,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: false,
  });

  assert.equal(fixture, "# notes\n");
  assert.equal(status.benchmarks.total, 1);
  assert.equal(status.benchmarks.invalid, 0);
  assert.deepEqual(status.invalidBenchmarks, []);
});

test("benchmark-import rejects overwrite without force", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-import-no-force-"));
  const manifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(manifestPath);

  await runBenchmarkImportCliCommand({
    path: manifestPath,
    memoryDir: tmpDir,
  });

  await assert.rejects(
    () =>
      runBenchmarkImportCliCommand({
        path: manifestPath,
        memoryDir: tmpDir,
      }),
    /rerun with force/i,
  );
});

test("benchmark-import allows overwrite with force", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-import-force-"));
  const manifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(manifestPath);

  await runBenchmarkImportCliCommand({
    path: manifestPath,
    memoryDir: tmpDir,
  });

  await writeManifest(manifestPath, "ama-memory");
  const result = await runBenchmarkImportCliCommand({
    path: manifestPath,
    memoryDir: tmpDir,
    force: true,
  });

  assert.equal(result.overwritten, true);
});
