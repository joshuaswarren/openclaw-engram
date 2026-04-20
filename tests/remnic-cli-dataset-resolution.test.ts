import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("PersonaMem downloaded markers require both benchmark csv and mirrored chat histories", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-personamem-status-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  await mkdir(benchmarkDir, { recursive: true });
  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    [
      "persona_id,chat_history_32k_link,user_query,correct_answer",
      "persona-1,data/chat_history_32k/persona-1.json,What tea do I order?,Earl Grey tea",
      "persona-2,data/chat_history_32k/persona-2.json,What coffee do I avoid?,Dark roast coffee",
    ].join("\n"),
    "utf8",
  );

  const cliEntry = pathToFileURL(
    path.join(process.cwd(), "packages/remnic-cli/src/index.ts"),
  ).href;
  const cliModule = await import(`${cliEntry}?personamem-status=${Date.now()}`);
  const hooks = cliModule.__benchDatasetTestHooks as {
    isDatasetDownloaded: (datasetPath: string, benchmarkId: string) => boolean;
  };

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "personamem"), false);

  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({ chat_history: [] }),
    "utf8",
  );

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "personamem"), false);

  await writeFile(
    path.join(chatHistoryDir, "persona-2.json"),
    JSON.stringify({ chat_history: [] }),
    "utf8",
  );

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "personamem"), true);
});

test("PersonaMem downloader does not skip an empty chat history directory", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-personamem-download-"));
  const datasetsDir = path.join(tmpDir, "datasets");
  const datasetDir = path.join(datasetsDir, "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(path.join(benchmarkDir, "benchmark.csv"), "placeholder\n", "utf8");

  const stubBinDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-stub-python-"));
  const pythonStubPath = path.join(stubBinDir, "python");
  await writeFile(pythonStubPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await chmod(pythonStubPath, 0o755);

  const scriptPath = path.join(process.cwd(), "evals", "scripts", "download-datasets.sh");
  const result = spawnSync("bash", [scriptPath, "--benchmark", "personamem"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATASETS_DIR: datasetsDir,
      PATH: `${stubBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[personamem\] Downloading from Hugging Face/);
  assert.doesNotMatch(result.stdout, /\[personamem\] Already downloaded/);
});
