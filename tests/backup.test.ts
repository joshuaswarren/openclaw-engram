import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFixtureMemoryDir } from "./transfer-fixtures.js";
import { backupMemoryDir } from "../src/transfer/backup.js";

test("v2.3 backup creates a timestamped directory", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-backup-"));
  const backupDir = await backupMemoryDir({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const name = path.basename(backupDir);
  assert.match(name, /^\d{4}-\d{2}-\d{2}T/);

  const entries = await readdir(backupDir);
  assert.ok(entries.includes("manifest.json"));
});

