import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import { parseConfig } from "../packages/remnic-core/src/config.ts";
import { buildProcedureRecallSection } from "../packages/remnic-core/src/procedural/procedure-recall.ts";
import { buildProcedureMarkdownBody } from "../packages/remnic-core/src/procedural/procedure-types.ts";

test("buildProcedureRecallSection returns ranked procedures on task-initiation prompts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-procedure-recall-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const body = buildProcedureMarkdownBody([
      { order: 1, intent: "Run deploy checks for production gateway" },
      { order: 2, intent: "Push the release tag" },
    ]);
    const id = await storage.writeMemory(
      "procedure",
      `When you deploy the gateway\n\n${body}`,
      { source: "test", tags: ["deploy", "gateway"] },
    );

    const config = parseConfig({
      memoryDir: dir,
      workspaceDir: path.join(dir, "ws"),
      openaiApiKey: "test-key",
      procedural: { enabled: true, recallMaxProcedures: 2 },
    });

    const section = await buildProcedureRecallSection(
      storage,
      "Let's deploy the gateway to production today",
      config,
    );
    assert.ok(section);
    assert.match(section, /## Relevant procedures/);
    assert.match(section, new RegExp(id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildProcedureRecallSection returns null when procedural.enabled is false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-procedure-recall-off-"));
  try {
    const storage = new StorageManager(dir);
    const config = parseConfig({
      memoryDir: dir,
      workspaceDir: path.join(dir, "ws"),
      openaiApiKey: "test-key",
      procedural: { enabled: false },
    });
    const section = await buildProcedureRecallSection(storage, "Let's deploy", config);
    assert.equal(section, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
