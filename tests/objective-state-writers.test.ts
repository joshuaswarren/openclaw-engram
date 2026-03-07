import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  deriveObjectiveStateSnapshotsFromAgentMessages,
  recordObjectiveStateSnapshotsFromAgentMessages,
} from "../src/objective-state-writers.js";
import { getObjectiveStateStoreStatus } from "../src/objective-state.js";

test("deriveObjectiveStateSnapshotsFromAgentMessages normalizes process and file tool results", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:00:00.000Z",
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-exec",
            function: {
              name: "exec_command",
              arguments: JSON.stringify({ cmd: "npm test" }),
            },
          },
          {
            id: "call-write",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "workspace/src/index.ts",
                content: "export const answer = 42;",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-exec",
        name: "exec_command",
        content: JSON.stringify({ exitCode: 0, stdout: "ok" }),
      },
      {
        role: "tool",
        tool_call_id: "call-write",
        name: "write_file",
        content: JSON.stringify({ ok: true }),
      },
    ],
  });

  assert.equal(snapshots.length, 2);

  const processSnapshot = snapshots[0];
  assert.equal(processSnapshot.kind, "process");
  assert.equal(processSnapshot.changeKind, "executed");
  assert.equal(processSnapshot.outcome, "success");
  assert.equal(processSnapshot.command, "npm test");
  assert.equal(processSnapshot.scope, "npm test");
  assert.equal(processSnapshot.toolName, "exec_command");
  assert.equal(processSnapshot.metadata?.toolCallId, "call-exec");

  const fileSnapshot = snapshots[1];
  assert.equal(fileSnapshot.kind, "file");
  assert.equal(fileSnapshot.changeKind, "updated");
  assert.equal(fileSnapshot.outcome, "success");
  assert.equal(fileSnapshot.scope, "workspace/src/index.ts");
  assert.equal(fileSnapshot.toolName, "write_file");
  assert.equal(fileSnapshot.after?.ref, "workspace/src/index.ts");
  assert.ok(fileSnapshot.after?.valueHash);
  assert.deepEqual(fileSnapshot.tags, ["agent-end", "tool:write_file"]);
});

test("deriveObjectiveStateSnapshotsFromAgentMessages falls back to generic failed tool snapshots", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:00.000Z",
    messages: [
      {
        role: "tool",
        name: "remote_search",
        content: JSON.stringify({ error: "upstream timeout" }),
      },
    ],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.kind, "tool");
  assert.equal(snapshots[0]?.changeKind, "failed");
  assert.equal(snapshots[0]?.outcome, "failure");
  assert.equal(snapshots[0]?.scope, "remote_search");
  assert.equal(snapshots[0]?.toolName, "remote_search");
});

test("deriveObjectiveStateSnapshotsFromAgentMessages hashes raw updates payloads once", () => {
  const updates = [{ oldText: "before", newText: "after" }];
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:30.000Z",
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-edit",
            function: {
              name: "edit_file",
              arguments: JSON.stringify({
                path: "workspace/src/objective-state.ts",
                updates,
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-edit",
        name: "edit_file",
        content: JSON.stringify({ ok: true }),
      },
    ],
  });

  const expectedHash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(updates)).digest("hex")}`;
  assert.equal(snapshots[0]?.after?.valueHash, expectedHash);
});

test("recordObjectiveStateSnapshotsFromAgentMessages respects flags and persists derived snapshots", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-writers-"));
  const input = {
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:02:00.000Z",
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-move",
            function: {
              name: "move_file",
              arguments: JSON.stringify({
                source: "workspace/tmp.txt",
                destination: "workspace/archive/tmp.txt",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-move",
        name: "move_file",
        content: JSON.stringify({ ok: true }),
      },
    ] as Array<Record<string, unknown>>,
  };

  const skipped = await recordObjectiveStateSnapshotsFromAgentMessages({
    memoryDir,
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: false,
    ...input,
  });
  assert.equal(skipped.snapshots.length, 0);
  assert.equal(skipped.filePaths.length, 0);

  const written = await recordObjectiveStateSnapshotsFromAgentMessages({
    memoryDir,
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    ...input,
  });
  assert.equal(written.snapshots.length, 1);
  assert.equal(written.filePaths.length, 1);
  assert.equal(written.snapshots[0]?.kind, "file");
  assert.equal(written.snapshots[0]?.changeKind, "updated");
  assert.equal(written.snapshots[0]?.before?.ref, "workspace/tmp.txt");
  assert.equal(written.snapshots[0]?.after?.ref, "workspace/archive/tmp.txt");

  const status = await getObjectiveStateStoreStatus({
    memoryDir,
    enabled: true,
    writesEnabled: true,
  });
  assert.equal(status.snapshots.total, 1);
  assert.equal(status.latestSnapshot?.scope, "workspace/archive/tmp.txt");
});
