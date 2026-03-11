import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  resolveMemoryDirForNamespace,
  runMemoryGovernanceCliCommand,
  runMemoryGovernanceReportCliCommand,
  runMemoryGovernanceRestoreCliCommand,
  runMemoryReviewDispositionCliCommand,
} from "../src/cli.ts";
import { StorageManager } from "../src/storage.ts";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function memoryDoc(id: string, content: string): string {
  return [
    "---",
    `id: ${id}`,
    "category: fact",
    "created: 2026-03-01T00:00:00.000Z",
    "updated: 2026-03-01T00:00:00.000Z",
    "source: test",
    "confidence: 0.2",
    "confidenceTier: speculative",
    "verificationState: disputed",
    "lifecycleState: candidate",
    "tags: [\"governance\"]",
    "---",
    "",
    content,
    "",
  ].join("\n");
}

test("governance CLI helpers round-trip apply/report/restore artifacts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-memory-governance-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-1.md",
      memoryDoc("fact-1", "A disputed speculative memory."),
    );

    const applyResult = await runMemoryGovernanceCliCommand({
      memoryDir,
      mode: "apply",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    assert.equal(applyResult.appliedActions.length > 0, true);

    const report = await runMemoryGovernanceReportCliCommand({
      memoryDir,
      runId: applyResult.runId,
    });
    assert.equal(report.summary.runId, applyResult.runId);
    assert.equal(report.summary.traceId, applyResult.traceId);
    assert.equal(report.reviewQueue.length > 0, true);
    assert.equal(report.manifest.traceId, applyResult.traceId);
    assert.equal(report.metrics.reviewReasons.disputed_memory >= 1, true);

    const restored = await runMemoryGovernanceRestoreCliCommand({
      memoryDir,
      runId: applyResult.runId,
      now: new Date("2026-03-09T12:30:00.000Z"),
    });
    assert.equal(restored.restoredActions > 0, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("review disposition helper sets rejected status for operator action", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-review-disposition-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-1.md",
      [
        "---",
        "id: fact-1",
        "category: fact",
        "created: 2026-03-01T00:00:00.000Z",
        "updated: 2026-03-01T00:00:00.000Z",
        "source: test",
        "confidence: 0.9",
        "confidenceTier: explicit",
        "tags: [\"review\"]",
        "---",
        "",
        "Operator disposition target.",
        "",
      ].join("\n"),
    );

    const result = await runMemoryReviewDispositionCliCommand({
      memoryDir,
      memoryId: "fact-1",
      status: "rejected",
      reasonCode: "operator_review",
      now: new Date("2026-03-09T13:00:00.000Z"),
    });
    assert.equal(result.status, "rejected");

    const memory = await new StorageManager(memoryDir).getMemoryById("fact-1");
    assert.equal(memory?.frontmatter.status, "rejected");
    const events = await new StorageManager(memoryDir).readMemoryLifecycleEvents();
    const event = events.find((entry) => entry.memoryId === "fact-1" && entry.eventType === "rejected");
    assert.ok(event);
    assert.equal(event.actor, "cli.review-disposition");
    assert.equal(event.reasonCode, "operator_review");
    assert.equal(event.ruleVersion, "memory-governance.v1");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("resolveMemoryDirForNamespace rejects unsupported namespace overrides when namespaces are disabled", async () => {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: false,
      defaultNamespace: "global",
    },
  } as any;

  await assert.rejects(
    () => resolveMemoryDirForNamespace(orchestrator, "team-alpha", { rejectUnsupportedOverride: true }),
    /namespaces are disabled; cannot target namespace: team-alpha/,
  );

  assert.equal(
    await resolveMemoryDirForNamespace(orchestrator, "global", { rejectUnsupportedOverride: true }),
    "/tmp/engram",
  );
});
