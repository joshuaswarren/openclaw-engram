import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  getWorkProductLedgerStatus,
  recordWorkProductLedgerEntry,
  resolveWorkProductLedgerDir,
  validateWorkProductLedgerEntry,
} from "../src/work-product-ledger.js";
import {
  runWorkProductRecordCliCommand,
  runWorkProductStatusCliCommand,
} from "../src/cli.js";

test("work-product ledger path resolves under memoryDir by default", () => {
  assert.equal(
    resolveWorkProductLedgerDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "work-product-ledger"),
  );
});

test("validateWorkProductLedgerEntry accepts the normalized contract", () => {
  const entry = validateWorkProductLedgerEntry({
    schemaVersion: 1,
    entryId: "wp-readme-refresh",
    recordedAt: "2026-03-07T23:20:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    kind: "artifact",
    action: "created",
    scope: "README.md",
    summary: "Created a refreshed README usage example for verified rules.",
    artifactPath: "README.md",
    objectiveStateSnapshotRefs: ["snap-readme-refresh"],
    entityRefs: ["repo:openclaw-engram"],
    tags: ["docs", "creation-memory"],
    metadata: { actor: "engram" },
  });

  assert.equal(entry.entryId, "wp-readme-refresh");
  assert.equal(entry.kind, "artifact");
  assert.deepEqual(entry.tags, ["docs", "creation-memory"]);
});

test("recordWorkProductLedgerEntry persists entries into dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-record-"));
  const filePath = await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-1",
      recordedAt: "2026-03-07T23:21:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "file",
      action: "updated",
      scope: "docs/config-reference.md",
      summary: "Updated config docs for creation-memory rollout.",
      artifactPath: "docs/config-reference.md",
      tags: ["docs"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "work-product-ledger", "entries", "2026-03-07", "wp-1.json"),
  );
});

test("work-product ledger status reports valid and invalid entries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-status-"));
  await recordWorkProductLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "wp-2",
      recordedAt: "2026-03-07T23:22:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "record",
      action: "created",
      scope: "salesforce:inventory:record-42",
      summary: "Created an inventory reconciliation record.",
      entityRefs: ["record:42"],
      tags: ["inventory"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "work-product-ledger",
    "entries",
    "2026-03-07",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, entryId: "" }, null, 2), "utf8");

  const status = await getWorkProductLedgerStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.entries.total, 2);
  assert.equal(status.entries.valid, 1);
  assert.equal(status.entries.invalid, 1);
  assert.equal(status.entries.byKind.record, 1);
  assert.equal(status.latestEntry?.entryId, "wp-2");
  assert.match(status.invalidEntries[0]?.path ?? "", /invalid\.json$/);
});

test("work-product-record CLI command writes entries only when creation-memory is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-product-cli-record-"));

  const skipped = await runWorkProductRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: false,
    entry: {
      schemaVersion: 1,
      entryId: "wp-skip",
      recordedAt: "2026-03-07T23:23:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "README.md",
      summary: "Would have created a README artifact entry.",
    },
  });
  assert.equal(skipped, null);

  const filePath = await runWorkProductRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    entry: {
      schemaVersion: 1,
      entryId: "wp-3",
      recordedAt: "2026-03-07T23:24:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "artifact",
      action: "created",
      scope: "README.md",
      summary: "Created a README artifact entry.",
      artifactPath: "README.md",
      tags: ["docs"],
    },
  });

  assert.match(filePath ?? "", /wp-3\.json$/);

  const status = await runWorkProductStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
  });
  assert.equal(status.entries.total, 1);
  assert.equal(status.latestEntry?.entryId, "wp-3");
});
