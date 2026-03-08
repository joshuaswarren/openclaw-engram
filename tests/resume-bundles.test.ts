import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  getResumeBundleStatus,
  recordResumeBundle,
  resolveResumeBundleDir,
  validateResumeBundle,
} from "../src/resume-bundles.js";
import {
  registerCli,
  runResumeBundleRecordCliCommand,
  runResumeBundleStatusCliCommand,
} from "../src/cli.js";

test("resume bundle path resolves under memoryDir by default", () => {
  assert.equal(
    resolveResumeBundleDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "resume-bundles"),
  );
});

test("validateResumeBundle accepts the normalized contract", () => {
  const bundle = validateResumeBundle({
    schemaVersion: 1,
    bundleId: "resume-pr27-foundation",
    recordedAt: "2026-03-08T03:00:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    scope: "openclaw-engram roadmap",
    summary: "Compact resume bundle for the next crash-recovery handoff.",
    objectiveStateSnapshotRefs: ["snapshot-1"],
    workProductEntryRefs: ["work-product-1"],
    commitmentEntryRefs: ["commitment-1"],
    keyFacts: ["PR26 merged cleanly"],
    nextActions: ["Start PR27 implementation"],
    riskFlags: ["builder not shipped yet"],
    metadata: { owner: "engram" },
  });

  assert.equal(bundle.bundleId, "resume-pr27-foundation");
  assert.deepEqual(bundle.keyFacts, ["PR26 merged cleanly"]);
  assert.deepEqual(bundle.nextActions, ["Start PR27 implementation"]);
});

test("validateResumeBundle reports bundleId field name on invalid ids", () => {
  assert.throws(
    () => validateResumeBundle({
      schemaVersion: 1,
      bundleId: "resume/pr27",
      recordedAt: "2026-03-08T03:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "bad bundle id",
      summary: "This bundle uses an unsafe id.",
    }),
    /bundleId/,
  );
});

test("recordResumeBundle persists bundles into dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-record-"));
  const filePath = await recordResumeBundle({
    memoryDir,
    bundle: {
      schemaVersion: 1,
      bundleId: "resume-pr27-1",
      recordedAt: "2026-03-08T03:01:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "PR27",
      summary: "Ship the resume bundle format slice.",
      nextActions: ["Open PR27"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "resume-bundles", "bundles", "2026-03-08", "resume-pr27-1.json"),
  );
});

test("resume bundle status reports valid and invalid bundles", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-status-"));
  await recordResumeBundle({
    memoryDir,
    bundle: {
      schemaVersion: 1,
      bundleId: "resume-pr27-2",
      recordedAt: "2026-03-08T03:02:00.000Z",
      sessionKey: "agent:main",
      source: "system",
      scope: "crash recovery",
      summary: "Snapshot the latest roadmap checkpoint for a fresh agent.",
      keyFacts: ["PR25 and PR26 merged"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "resume-bundles",
    "bundles",
    "2026-03-08",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, bundleId: "" }, null, 2), "utf8");

  const status = await getResumeBundleStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.bundles.total, 2);
  assert.equal(status.bundles.valid, 1);
  assert.equal(status.bundles.invalid, 1);
  assert.equal(status.bundles.bySource.system, 1);
  assert.equal(status.latestBundle?.bundleId, "resume-pr27-2");
  assert.match(status.invalidBundles[0]?.path ?? "", /invalid\.json$/);
});

test("resume-bundle CLI commands write and report only when the feature is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-cli-"));

  const skipped = await runResumeBundleRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: false,
    bundle: {
      schemaVersion: 1,
      bundleId: "resume-skip",
      recordedAt: "2026-03-08T03:03:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "skip",
      summary: "Would have written a resume bundle.",
    },
  });
  assert.equal(skipped, null);

  const filePath = await runResumeBundleRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: true,
    bundle: {
      schemaVersion: 1,
      bundleId: "resume-pr27-3",
      recordedAt: "2026-03-08T03:04:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      scope: "resume scope",
      summary: "Bundle the current state for the next autonomous PR slice.",
      nextActions: ["Continue PR loop"],
    },
  });

  assert.match(filePath ?? "", /resume-pr27-3\.json$/);

  const disabledStatus = await runResumeBundleStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: false,
  });
  assert.equal(disabledStatus.enabled, false);

  const enabledStatus = await runResumeBundleStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: true,
  });
  assert.equal(enabledStatus.bundles.total, 1);
  assert.equal(enabledStatus.latestBundle?.bundleId, "resume-pr27-3");
});

test("resume-bundle CLI wiring records bundles through command registration", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-resume-bundle-cli-wiring-"));

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
        creationMemoryEnabled: true,
        resumeBundlesEnabled: true,
        resumeBundleDir: path.join(memoryDir, "state", "resume-bundles"),
      },
    } as never,
  );

  const action = root.children.get("engram")?.children.get("resume-bundle-record")?.actionHandler;
  assert.equal(typeof action, "function");

  await action?.({
    bundleId: "resume-pr27-4",
    recordedAt: "2026-03-08T03:05:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    scope: "handoff",
    summary: "Persist a deterministic resume bundle shell.",
    keyFact: ["PR27 is format-only"],
    nextAction: ["Implement PR28 builder later"],
    riskFlag: ["No transcript synthesis yet"],
  });

  const status = await runResumeBundleStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    resumeBundlesEnabled: true,
  });
  assert.equal(status.bundles.total, 1);
  assert.deepEqual(status.latestBundle?.keyFacts, ["PR27 is format-only"]);
  assert.deepEqual(status.latestBundle?.nextActions, ["Implement PR28 builder later"]);
});
