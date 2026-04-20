import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

  assert.equal(hooks.isDatasetDownloaded(datasetDir, "personamem"), true);
});
