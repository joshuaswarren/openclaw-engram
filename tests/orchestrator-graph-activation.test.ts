import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("buildGraphEdge writes fallback session adjacency when enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-adj-enabled-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    multiGraphMemoryEnabled: true,
    graphWriteSessionAdjacencyEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg);

  let captured: any = null;
  (orchestrator as any).graphIndexFor = () => ({
    onMemoryWritten: async (opts: any) => {
      captured = opts;
    },
  });

  await (orchestrator as any).buildGraphEdge(
    { dir: memoryDir },
    "facts/2026-02-24/current.md",
    undefined,
    "current",
    "content",
    [],
    new Map(),
    undefined,
    undefined,
    "facts/2026-02-24/previous.md",
  );

  assert.ok(captured);
  assert.deepEqual(captured.recentInThread, ["facts/2026-02-24/previous.md"]);
});

test("buildGraphEdge skips fallback session adjacency when disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-adj-disabled-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    multiGraphMemoryEnabled: true,
    graphWriteSessionAdjacencyEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  let captured: any = null;
  (orchestrator as any).graphIndexFor = () => ({
    onMemoryWritten: async (opts: any) => {
      captured = opts;
    },
  });

  await (orchestrator as any).buildGraphEdge(
    { dir: memoryDir },
    "facts/2026-02-24/current.md",
    undefined,
    "current",
    "content",
    [],
    new Map(),
    undefined,
    undefined,
    "facts/2026-02-24/previous.md",
  );

  assert.ok(captured);
  assert.deepEqual(captured.recentInThread, []);
});
