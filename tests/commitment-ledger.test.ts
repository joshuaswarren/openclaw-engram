import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  getCommitmentLedgerStatus,
  recordCommitmentLedgerEntry,
  resolveCommitmentLedgerDir,
  validateCommitmentLedgerEntry,
} from "../src/commitment-ledger.js";
import {
  registerCli,
  runCommitmentRecordCliCommand,
  runCommitmentStatusCliCommand,
} from "../src/cli.js";

test("commitment ledger path resolves under memoryDir by default", () => {
  assert.equal(
    resolveCommitmentLedgerDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "commitment-ledger"),
  );
});

test("validateCommitmentLedgerEntry accepts the normalized contract", () => {
  const entry = validateCommitmentLedgerEntry({
    schemaVersion: 1,
    entryId: "commitment-pr25-follow-up",
    recordedAt: "2026-03-08T02:16:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    kind: "follow_up",
    state: "open",
    scope: "openclaw-engram roadmap",
    summary: "Follow up with the next PR slice for commitment memory.",
    dueAt: "2026-03-09T12:00:00.000Z",
    entityRefs: ["repo:openclaw-engram"],
    workProductEntryRefs: ["wp-readme-guide"],
    objectiveStateSnapshotRefs: ["snap-roadmap"],
    tags: ["creation-memory", "commitments"],
    metadata: { owner: "engram" },
  });

  assert.equal(entry.kind, "follow_up");
  assert.equal(entry.state, "open");
  assert.equal(entry.dueAt, "2026-03-09T12:00:00.000Z");
});

test("recordCommitmentLedgerEntry persists entries into dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-record-"));
  const filePath = await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr25-1",
      recordedAt: "2026-03-08T02:17:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "deadline",
      state: "open",
      scope: "PR25",
      summary: "Ship the commitment ledger slice.",
      dueAt: "2026-03-08T05:00:00.000Z",
      tags: ["deadline"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "commitment-ledger", "entries", "2026-03-08", "commitment-pr25-1.json"),
  );
});

test("commitment ledger status reports valid and invalid entries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-status-"));
  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr25-2",
      recordedAt: "2026-03-08T02:18:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "promise",
      state: "open",
      scope: "public docs",
      summary: "Document contribution workflow after the slice merges.",
      tags: ["docs"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "commitment-ledger",
    "entries",
    "2026-03-08",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, entryId: "" }, null, 2), "utf8");

  const status = await getCommitmentLedgerStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.entries.total, 2);
  assert.equal(status.entries.valid, 1);
  assert.equal(status.entries.invalid, 1);
  assert.equal(status.entries.byKind.promise, 1);
  assert.equal(status.entries.byState.open, 1);
  assert.equal(status.latestEntry?.entryId, "commitment-pr25-2");
  assert.match(status.invalidEntries[0]?.path ?? "", /invalid\.json$/);
});

test("commitment-record CLI command writes entries only when commitment ledger is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-cli-record-"));

  const skipped = await runCommitmentRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: false,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-skip",
      recordedAt: "2026-03-08T02:19:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "skip",
      summary: "Would have written a commitment entry.",
    },
  });
  assert.equal(skipped, null);

  const filePath = await runCommitmentRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr25-3",
      recordedAt: "2026-03-08T02:20:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "next slice",
      summary: "Start the fulfillment/lifecycle integration slice.",
      tags: ["next"],
    },
  });

  assert.match(filePath ?? "", /commitment-pr25-3\.json$/);

  const status = await runCommitmentStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
  });
  assert.equal(status.entries.total, 1);
  assert.equal(status.latestEntry?.entryId, "commitment-pr25-3");
});

test("commitment-record CLI wiring records entries through command registration", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-cli-wiring-"));

  class MockCommand {
    children = new Map<string, MockCommand>();
    actionHandler?: (...args: unknown[]) => Promise<void> | void;

    constructor(readonly name: string) {}

    command(name: string): MockCommand {
      const child = new MockCommand(name);
      this.children.set(name, child);
      return child;
    }

    description(): MockCommand {
      return this;
    }

    option(): MockCommand {
      return this;
    }

    requiredOption(): MockCommand {
      return this;
    }

    argument(): MockCommand {
      return this;
    }

    action(handler: (...args: unknown[]) => Promise<void> | void): MockCommand {
      this.actionHandler = handler;
      return this;
    }
  }

  const root = new MockCommand("root");
  registerCli(
    {
      registerCli(handler: (opts: { program: MockCommand }) => void): void {
        handler({ program: root });
      },
    },
    {
      config: {
        memoryDir,
        commitmentLedgerDir: path.join(memoryDir, "state", "commitment-ledger"),
        creationMemoryEnabled: true,
        commitmentLedgerEnabled: true,
      },
    } as never,
  );

  const action = root.children.get("engram")?.children.get("commitment-record")?.actionHandler;
  assert.equal(typeof action, "function");

  await action?.({
    entryId: "commitment-pr25-4",
    recordedAt: "2026-03-08T02:21:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    kind: "promise",
    state: "open",
    scope: "promise scope",
    summary: "Keep PR slices small and feature-flagged.",
    tag: ["process"],
  });

  const status = await runCommitmentStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
  });
  assert.equal(status.entries.total, 1);
  assert.equal(status.latestEntry?.entryId, "commitment-pr25-4");
  assert.equal(status.latestEntry?.kind, "promise");
});
