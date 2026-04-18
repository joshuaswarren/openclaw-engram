import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";

test("eval runner rejects dataset overrides when benchmark=all", async () => {
  const datasetDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-evals-all-dataset-"),
  );
  const tsxPath = path.resolve("node_modules/.bin/tsx");
  const result = spawnSync(
    tsxPath,
    [
      "evals/run.ts",
      "--benchmark",
      "all",
      "--dataset-dir",
      datasetDir,
      "--lightweight",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /--dataset-dir cannot be used with --benchmark all/i,
  );
});
