import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { rebuildObservations } from "../src/maintenance/rebuild-observations.js";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("rebuildObservations dry-run computes rows without writing output", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-dry-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-02-25T10:01:00.000Z",
        role: "user",
        content: "u1",
        sessionKey: "agent:main:default",
        turnId: "t1",
      }),
      JSON.stringify({
        timestamp: "2026-02-25T10:02:00.000Z",
        role: "assistant",
        content: "a1",
        sessionKey: "agent:main:default",
        turnId: "t2",
      }),
    ].join("\n") + "\n",
  );

  const result = await rebuildObservations({ memoryDir });
  assert.equal(result.dryRun, true);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.parsedTurns, 2);
  assert.equal(result.rebuiltRows, 1);

  await assert.rejects(() => stat(result.outputPath));
});

test("rebuildObservations writes deterministic ledger and backs up existing file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-live-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    [
      JSON.stringify({
        timestamp: "2026-02-25T10:01:00.000Z",
        role: "user",
        content: "u1",
        sessionKey: "agent:main:default",
        turnId: "t1",
      }),
      JSON.stringify({
        timestamp: "2026-02-25T11:02:00.000Z",
        role: "assistant",
        content: "a1",
        sessionKey: "agent:main:default",
        turnId: "t2",
      }),
    ].join("\n") + "\n",
  );
  await writeText(
    memoryDir,
    "state/observation-ledger/rebuilt-observations.jsonl",
    "{\"legacy\":true}\n",
  );

  const result = await rebuildObservations({
    memoryDir,
    dryRun: false,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });

  assert.equal(result.rebuiltRows, 2);
  assert.equal(result.backupPath != null, true);

  const backupRaw = await readFile(result.backupPath as string, "utf-8");
  assert.equal(backupRaw, "{\"legacy\":true}\n");

  const rebuiltRaw = await readFile(result.outputPath, "utf-8");
  const lines = rebuiltRaw.trim().split("\n").map((line) => JSON.parse(line) as any);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => ({ sessionKey: line.sessionKey, hour: line.hour, turnCount: line.turnCount })),
    [
      { sessionKey: "agent:main:default", hour: "2026-02-25T10:00:00.000Z", turnCount: 1 },
      { sessionKey: "agent:main:default", hour: "2026-02-25T11:00:00.000Z", turnCount: 1 },
    ],
  );
});

test("rebuildObservations ignores malformed transcript lines fail-open", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-observations-malformed-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    [
      "{not-json}",
      JSON.stringify({
        timestamp: "2026-02-25T10:01:00.000Z",
        role: "user",
        content: "ok",
        sessionKey: "agent:main:default",
        turnId: "t1",
      }),
    ].join("\n") + "\n",
  );

  const result = await rebuildObservations({ memoryDir });
  assert.equal(result.malformedLines, 1);
  assert.equal(result.parsedTurns, 1);
  assert.equal(result.rebuiltRows, 1);
});
