import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { HourlySummarizer } from "./summarizer.js";
import {
  readSummarySnapshot,
  summarySnapshotPath,
  writeSummarySnapshot,
} from "./summary-snapshot.js";
import type { PluginConfig } from "./types.js";

function makeConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    localLlmEnabled: false,
    localLlmFallback: true,
    localLlmUrl: "http://localhost:1234/v1",
    localLlmModel: "local-model",
  } as PluginConfig;
}

function utcDateString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("summary snapshot helpers round-trip summaries in descending hour order", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-snapshot-"),
  );
  const sessionKey = "session-snapshot";
  const summaries = [
    {
      hour: "2026-03-26T08:00:00.000Z",
      sessionKey,
      bullets: ["older bullet"],
      turnCount: 3,
      generatedAt: "2026-03-26T08:15:00.000Z",
    },
    {
      hour: "2026-03-26T14:00:00.000Z",
      sessionKey,
      bullets: ["newer bullet"],
      turnCount: 4,
      generatedAt: "2026-03-26T14:15:00.000Z",
    },
  ];

  await writeSummarySnapshot(memoryDir, sessionKey, summaries);

  assert.equal(
    summarySnapshotPath(memoryDir, sessionKey),
    path.join(memoryDir, "state", "summaries", `${sessionKey}.json`),
  );

  const loaded = await readSummarySnapshot(memoryDir, sessionKey);
  assert.deepEqual(loaded, [summaries[1], summaries[0]]);
});

test("readRecent prefers the materialized summary snapshot over markdown fallback", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-prefers-snapshot-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "session-prefers-snapshot";
  const now = new Date();
  const dateStr = utcDateString(now);
  const mdDir = path.join(memoryDir, "summaries", "hourly", sessionKey);
  await mkdir(mdDir, { recursive: true });

  await writeSummarySnapshot(memoryDir, sessionKey, [
    {
      hour: `${dateStr}T14:00:00.000Z`,
      sessionKey,
      bullets: ["snapshot bullet"],
      turnCount: 2,
      generatedAt: "2026-03-26T14:15:00.000Z",
    },
  ]);

  await writeFile(
    path.join(mdDir, `${dateStr}.md`),
    [
      `# Hourly Summaries — ${dateStr}`,
      "",
      `*Session: ${sessionKey}*`,
      "",
      "## 14:00",
      "",
      "- markdown bullet",
      "  *(2 turns)*",
      "",
    ].join("\n"),
    "utf-8",
  );

  const recent = await summarizer.readRecent(sessionKey, 48);
  assert.deepEqual(
    recent.map((summary) => summary.bullets),
    [["snapshot bullet"]],
  );
});

test("readRecent backfills a summary snapshot from markdown summaries", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-summary-backfill-"),
  );
  const summarizer = new HourlySummarizer(makeConfig(memoryDir));
  await summarizer.initialize();

  const sessionKey = "session-backfill";
  const now = new Date();
  const dateStr = utcDateString(now);
  const mdDir = path.join(memoryDir, "summaries", "hourly", sessionKey);
  await mkdir(mdDir, { recursive: true });

  await writeFile(
    path.join(mdDir, `${dateStr}.md`),
    [
      `# Hourly Summaries — ${dateStr}`,
      "",
      `*Session: ${sessionKey}*`,
      "",
      "## 09:00",
      "",
      "- markdown bullet",
      "  *(2 turns)*",
      "",
    ].join("\n"),
    "utf-8",
  );

  assert.equal(await readSummarySnapshot(memoryDir, sessionKey), null);

  const recent = await summarizer.readRecent(sessionKey, 48);
  assert.equal(recent.length, 1);
  assert.deepEqual(recent[0]?.bullets, ["markdown bullet"]);

  const snapshot = await readSummarySnapshot(memoryDir, sessionKey);
  assert.deepEqual(snapshot, recent);
});
