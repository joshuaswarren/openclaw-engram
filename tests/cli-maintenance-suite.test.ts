import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import {
  runArchiveObservationsCliCommand,
  runMemoryTimelineCliCommand,
  runRebuildMemoryLifecycleLedgerCliCommand,
  runRebuildMemoryProjectionCliCommand,
  runMigrateObservationsCliCommand,
  runRebuildObservationsCliCommand,
} from "../src/cli.js";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("archive-observations CLI wrapper defaults to dry-run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-archive-observations-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-01-01.jsonl",
    "{\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n",
  );

  const result = await runArchiveObservationsCliCommand({
    memoryDir,
    retentionDays: 30,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.scannedFiles, 1);
});

test("rebuild-observations CLI wrapper writes only with --write semantics", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-observations-"));
  await writeText(
    memoryDir,
    "transcripts/main/default/2026-02-25.jsonl",
    JSON.stringify({
      timestamp: "2026-02-25T10:05:00.000Z",
      role: "user",
      content: "u1",
      sessionKey: "agent:main:default",
    }) + "\n",
  );

  const dryRunResult = await runRebuildObservationsCliCommand({ memoryDir });
  assert.equal(dryRunResult.dryRun, true);
  await assert.rejects(() => stat(dryRunResult.outputPath));

  const writeResult = await runRebuildObservationsCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });
  assert.equal(writeResult.dryRun, false);
  await stat(writeResult.outputPath);
});

test("rebuild-memory-lifecycle-ledger CLI wrapper respects dry-run default and write mode", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-memory-lifecycle-"));
  await writeText(
    memoryDir,
    "facts/2026-03-08/fact-1.md",
    `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
  );

  const dryRunResult = await runRebuildMemoryLifecycleLedgerCliCommand({ memoryDir });
  assert.equal(dryRunResult.dryRun, true);
  await assert.rejects(() => stat(dryRunResult.outputPath));

  const writeResult = await runRebuildMemoryLifecycleLedgerCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-03-08T12:00:00.000Z"),
  });
  assert.equal(writeResult.dryRun, false);
  await stat(writeResult.outputPath);
});

test("rebuild-memory-projection CLI wrapper respects dry-run default and write mode", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-rebuild-memory-projection-"));
  await writeText(
    memoryDir,
    "facts/2026-03-08/fact-1.md",
    `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
  );

  const dryRunResult = await runRebuildMemoryProjectionCliCommand({ memoryDir });
  assert.equal(dryRunResult.dryRun, true);
  await assert.rejects(() => stat(dryRunResult.outputPath));

  const writeResult = await runRebuildMemoryProjectionCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-03-08T12:00:00.000Z"),
  });
  assert.equal(writeResult.dryRun, false);
  await stat(writeResult.outputPath);
});

test("memory-timeline CLI wrapper reads rows from the derived projection store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-memory-timeline-"));
  await writeText(
    memoryDir,
    "facts/2026-03-08/fact-1.md",
    `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
  );
  await runRebuildMemoryProjectionCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-03-08T12:00:00.000Z"),
  });

  const rows = await runMemoryTimelineCliCommand({
    memoryDir,
    memoryId: "fact-1",
  });
  assert.deepEqual(rows.map((row) => row.eventType), ["created", "updated"]);
});

test("migrate-observations CLI wrapper respects dry-run default and write mode", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-migrate-observations-"));
  await writeText(
    memoryDir,
    "state/observation-ledger/legacy.jsonl",
    JSON.stringify({
      session: "agent:main:default",
      timestamp: "2026-02-25T10:05:00.000Z",
      role: "user",
    }) + "\n",
  );

  const dryRunResult = await runMigrateObservationsCliCommand({ memoryDir });
  assert.equal(dryRunResult.dryRun, true);
  await assert.rejects(() => stat(dryRunResult.outputPath));

  const writeResult = await runMigrateObservationsCliCommand({
    memoryDir,
    write: true,
    now: new Date("2026-02-26T12:00:00.000Z"),
  });
  assert.equal(writeResult.dryRun, false);
  await stat(writeResult.outputPath);
});
