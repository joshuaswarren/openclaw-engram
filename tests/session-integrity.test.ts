import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { analyzeSessionIntegrity, applySessionRepair, planSessionRepair } from "../src/session-integrity.js";

async function buildMemoryDir(prefix: string): Promise<string> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(memoryDir, "transcripts", "main", "default"), { recursive: true });
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  return memoryDir;
}

test("analyzeSessionIntegrity reports transcript and checkpoint anomalies", async () => {
  const memoryDir = await buildMemoryDir("engram-session-integrity-");
  const transcriptPath = path.join(memoryDir, "transcripts", "main", "default", "2026-02-28.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        timestamp: "2026-02-28T10:00:00.000Z",
        role: "user",
        content: "first",
        sessionKey: "agent:generalist:main",
        turnId: "t1",
      }),
      JSON.stringify({
        timestamp: "2026-02-28T10:01:00.000Z",
        role: "user",
        content: "second without assistant",
        sessionKey: "agent:generalist:main",
        turnId: "t1",
      }),
      "{bad json",
    ].join("\n"),
    "utf-8",
  );

  await writeFile(
    path.join(memoryDir, "state", "checkpoint.json"),
    JSON.stringify({
      sessionKey: "agent:generalist:main",
      capturedAt: "2026-02-28T12:00:00.000Z",
      ttl: "2026-02-28T11:00:00.000Z",
      turns: [],
    }),
    "utf-8",
  );

  const report = await analyzeSessionIntegrity({ memoryDir });
  assert.equal(report.healthy, false);

  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.equal(codes.has("transcript_malformed_line"), true);
  assert.equal(codes.has("transcript_duplicate_turn_id"), true);
  assert.equal(codes.has("transcript_broken_chain"), true);
  assert.equal(codes.has("transcript_incomplete_turn"), true);
  assert.equal(codes.has("checkpoint_invalid_metadata"), true);
});

test("session repair apply rewrites transcript and removes bad checkpoint", async () => {
  const memoryDir = await buildMemoryDir("engram-session-repair-");
  const transcriptPath = path.join(memoryDir, "transcripts", "main", "default", "2026-02-28.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        timestamp: "2026-02-28T10:00:00.000Z",
        role: "user",
        content: "hello",
        sessionKey: "agent:generalist:main",
        turnId: "turn-1",
      }),
      "not-json",
      JSON.stringify({
        timestamp: "2026-02-28T10:01:00.000Z",
        role: "assistant",
        content: 42,
        sessionKey: "agent:generalist:main",
        turnId: "turn-2",
      }),
    ].join("\n"),
    "utf-8",
  );
  const checkpointPath = path.join(memoryDir, "state", "checkpoint.json");
  await writeFile(checkpointPath, "{bad-json", "utf-8");

  const report = await analyzeSessionIntegrity({ memoryDir });
  const plan = planSessionRepair({
    report,
    dryRun: false,
  });
  const result = await applySessionRepair({ plan });
  assert.equal(result.applied, true);
  assert.equal(result.errors.length, 0);

  const repaired = await readFile(transcriptPath, "utf-8");
  const lines = repaired.trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { turnId: string };
  assert.equal(parsed.turnId, "turn-1");

  await assert.rejects(() => access(checkpointPath));
});

test("session repair plan skips transcript rewrite when only chain/duplicate issues exist", async () => {
  const memoryDir = await buildMemoryDir("engram-session-repair-plan-");
  const transcriptPath = path.join(memoryDir, "transcripts", "main", "default", "2026-02-28.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        timestamp: "2026-02-28T10:00:00.000Z",
        role: "user",
        content: "first",
        sessionKey: "agent:generalist:main",
        turnId: "turn-1",
      }),
      JSON.stringify({
        timestamp: "2026-02-28T10:01:00.000Z",
        role: "user",
        content: "second",
        sessionKey: "agent:generalist:main",
        turnId: "turn-2",
      }),
    ].join("\n"),
    "utf-8",
  );

  const report = await analyzeSessionIntegrity({ memoryDir });
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.equal(codes.has("transcript_broken_chain"), true);
  assert.equal(codes.has("transcript_incomplete_turn"), true);
  assert.equal(codes.has("transcript_malformed_line"), false);
  assert.equal(codes.has("transcript_invalid_entry"), false);

  const plan = planSessionRepair({ report, dryRun: true });
  const rewriteActions = plan.actions.filter((action) => action.kind === "rewrite_transcript");
  assert.equal(rewriteActions.length, 0);
});
