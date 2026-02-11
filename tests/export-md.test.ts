import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFixtureMemoryDir } from "./transfer-fixtures.js";
import { exportMarkdownBundle } from "../src/transfer/export-md.js";

test("v2.3 md export copies files and writes a manifest", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  await exportMarkdownBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf-8")) as any;
  assert.equal(manifest.format, "openclaw-engram-export");
  assert.ok(Array.isArray(manifest.files));

  const fact = await readFile(path.join(outDir, "facts", "2026-02-11", "fact-1.md"), "utf-8");
  assert.match(fact, /pianos/);
});

