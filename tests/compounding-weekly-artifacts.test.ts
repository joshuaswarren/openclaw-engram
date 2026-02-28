import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { CompoundingEngine } from "../src/compounding/engine.js";
import type { PluginConfig } from "../src/types.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function buildConfig(memoryDir: string, sharedContextDir: string, overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    ...parseConfig({
      memoryDir,
      sharedContextDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: true,
      continuityAuditEnabled: false,
    }),
    ...overrides,
  };
}

test("weekly compounding writes rubrics artifact even with no feedback", async () => {
  const memoryDir = tmpDir("engram-compound-weekly-empty-mem");
  const sharedDir = tmpDir("engram-compound-weekly-empty-shared");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  const result = await engine.synthesizeWeekly({ weekId: "2026-W09" });

  const report = await readFile(result.reportPath, "utf-8");
  const rubrics = await readFile(result.rubricsPath, "utf-8");

  assert.match(report, /## Outcome Weighting/);
  assert.match(report, /\(no action outcomes recorded this week\)/);
  assert.match(rubrics, /^# Compounding Rubrics/m);
  assert.match(rubrics, /## Agent Rubrics/);
  assert.match(rubrics, /\(none yet\)/);
});

test("weekly report includes provenance references for feedback-derived patterns", async () => {
  const memoryDir = tmpDir("engram-compound-weekly-prov-mem");
  const sharedDir = tmpDir("engram-compound-weekly-prov-shared");
  await mkdir(path.join(sharedDir, "feedback"), { recursive: true });

  const feedbackPath = path.join(sharedDir, "feedback", "inbox.jsonl");
  await writeFile(
    feedbackPath,
    [
      JSON.stringify({
        agent: "agent-a",
        decision: "approved_with_feedback",
        reason: "tighten confidence thresholds",
        date: "2026-02-25T10:00:00.000Z",
        learning: "Include explicit confidence rationale",
      }),
      JSON.stringify({
        agent: "agent-b",
        decision: "rejected",
        reason: "Used stale source",
        date: "2026-02-26T11:00:00.000Z",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );

  const engine = new CompoundingEngine(buildConfig(memoryDir, sharedDir));
  const result = await engine.synthesizeWeekly({ weekId: "2026-W09" });
  const report = await readFile(result.reportPath, "utf-8");
  const rubrics = await readFile(result.rubricsPath, "utf-8");

  assert.match(report, /## Patterns \(Avoid \/ Prefer\)/);
  assert.match(report, /source: inbox\.jsonl:L1#agent-a-2026-02-25T10:00:00\.000Z-1/);
  assert.match(report, /source: inbox\.jsonl:L2#agent-b-2026-02-26T11:00:00\.000Z-2/);
  assert.match(rubrics, /source: inbox\.jsonl:L1#agent-a-2026-02-25T10:00:00\.000Z-1/);
});
