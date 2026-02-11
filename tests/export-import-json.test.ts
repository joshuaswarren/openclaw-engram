import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJsonBundle } from "../src/transfer/export-json.js";
import { importJsonBundle } from "../src/transfer/import-json.js";
import { writeFixtureMemoryDir } from "./transfer-fixtures.js";

test("v2.3 json export/import round-trips (without transcripts by default)", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  await exportJsonBundle({
    memoryDir: memDir,
    outDir,
    includeTranscripts: false,
    pluginVersion: "2.2.3",
  });

  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as any;
  assert.equal(manifest.includesTranscripts, false);
  assert.ok(Array.isArray(manifest.files));

  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const res = await importJsonBundle({ targetMemoryDir: targetDir, fromDir: outDir, conflict: "skip" });
  assert.ok(res.written > 0);

  const importedProfile = await readFile(path.join(targetDir, "profile.md"), "utf-8");
  assert.match(importedProfile, /Prefers concise/);

  const fact = await readFile(path.join(targetDir, "facts", "2026-02-11", "fact-1.md"), "utf-8");
  assert.match(fact, /The user likes pianos/);
});

