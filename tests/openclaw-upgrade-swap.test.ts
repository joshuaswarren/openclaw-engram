import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  cleanupRollbackDirectory,
  restoreDirectoryFromRollback,
  runBestEffortGatewayRestart,
  rollbackOpenclawUpgrade,
  swapDirectoryWithRollback,
} from "../packages/remnic-cli/src/openclaw-upgrade-swap.ts";

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "openclaw-upgrade-swap-test-"));
}

function writeMarker(dirPath: string, value: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "marker.txt"), value, "utf8");
}

function readMarker(dirPath: string): string {
  return fs.readFileSync(path.join(dirPath, "marker.txt"), "utf8");
}

test("swapDirectoryWithRollback preserves the previous plugin copy until cleanup", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const stagedDir = path.join(tmp, "staged");
  const rollbackDir = path.join(tmp, "rollback");

  writeMarker(pluginDir, "old-plugin");
  writeMarker(stagedDir, "new-plugin");

  const result = swapDirectoryWithRollback(stagedDir, pluginDir, rollbackDir);

  assert.equal(result.rollbackDir, rollbackDir);
  assert.equal(readMarker(pluginDir), "new-plugin");
  assert.equal(readMarker(rollbackDir), "old-plugin");
  assert.equal(fs.existsSync(stagedDir), false);
});

test("cleanupRollbackDirectory removes the preserved rollback copy after success", async () => {
  const tmp = await makeTmpDir();
  const rollbackDir = path.join(tmp, "rollback");

  writeMarker(rollbackDir, "old-plugin");
  cleanupRollbackDirectory(rollbackDir);

  assert.equal(fs.existsSync(rollbackDir), false);
});

test("restoreDirectoryFromRollback reinstates the previous plugin copy", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const stagedDir = path.join(tmp, "staged");
  const rollbackDir = path.join(tmp, "rollback");

  writeMarker(pluginDir, "old-plugin");
  writeMarker(stagedDir, "new-plugin");

  const result = swapDirectoryWithRollback(stagedDir, pluginDir, rollbackDir);
  assert.equal(readMarker(pluginDir), "new-plugin");

  restoreDirectoryFromRollback(pluginDir, result.rollbackDir!);

  assert.equal(readMarker(pluginDir), "old-plugin");
  assert.equal(fs.existsSync(rollbackDir), false);
});

test("rollbackOpenclawUpgrade restores plugin and config from rollback artifacts", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const rollbackDir = path.join(tmp, "rollback");
  const configPath = path.join(tmp, "openclaw.json");
  const configBackupPath = path.join(tmp, "backups", "openclaw.json");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(rollbackDir, "old-plugin");
  fs.writeFileSync(configPath, '{"plugins":{"slots":{"memory":"broken"}}}\n', "utf8");
  fs.mkdirSync(path.dirname(configBackupPath), { recursive: true });
  fs.writeFileSync(configBackupPath, '{"plugins":{"slots":{"memory":"openclaw-remnic"}}}\n', "utf8");

  const notes = rollbackOpenclawUpgrade({
    configBackupPath,
    configPath,
    pluginDir,
    rollbackDir,
  });

  assert.equal(readMarker(pluginDir), "old-plugin");
  assert.match(fs.readFileSync(configPath, "utf8"), /openclaw-remnic/);
  assert.ok(notes.some((note) => note.includes("Restored previous plugin from rollback copy")));
  assert.ok(notes.some((note) => note.includes("Restored OpenClaw config from backup")));
});

test("rollbackOpenclawUpgrade falls back to the durable plugin backup when rollback dir is gone", async () => {
  const tmp = await makeTmpDir();
  const pluginDir = path.join(tmp, "extensions", "openclaw-remnic");
  const pluginBackupDir = path.join(tmp, "backups", "extensions", "openclaw-remnic");
  const configPath = path.join(tmp, "openclaw.json");

  writeMarker(pluginDir, "new-plugin");
  writeMarker(pluginBackupDir, "old-plugin");
  fs.writeFileSync(configPath, '{"plugins":{"slots":{"memory":"broken"}}}\n', "utf8");

  const notes = rollbackOpenclawUpgrade({
    configPath,
    pluginBackupDir,
    pluginDir,
  });

  assert.equal(readMarker(pluginDir), "old-plugin");
  assert.ok(notes.some((note) => note.includes("Restored previous plugin from backup")));
});

test("runBestEffortGatewayRestart reports success when launchctl restart works", () => {
  const result = runBestEffortGatewayRestart(() => {}, "ai.openclaw.gateway");

  assert.equal(result.restarted, true);
  assert.match(result.message, /Restarted OpenClaw gateway/);
});

test("runBestEffortGatewayRestart degrades to a warning when launchctl restart fails", () => {
  const result = runBestEffortGatewayRestart(() => {
    throw new Error("launchctl failed");
  }, "ai.openclaw.gateway");

  assert.equal(result.restarted, false);
  assert.match(result.message, /upgrade completed, but the automatic OpenClaw gateway restart failed/);
  assert.match(result.message, /launchctl kickstart -k gui\/\$\(id -u\)\/ai\.openclaw\.gateway/);
});
