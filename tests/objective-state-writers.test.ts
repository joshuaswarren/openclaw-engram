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

test("deriveObjectiveStateSnapshotsFromAgentMessages does not classify remove-prefixed tools as file operations", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:05.000Z",
    messages: [
      {
        role: "tool",
        name: "remove_entry",
        content: JSON.stringify({ ok: true }),
      },
    ],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.kind, "tool");
  assert.equal(snapshots[0]?.changeKind, "observed");
  assert.equal(snapshots[0]?.scope, "remove_entry");
});

test("deriveObjectiveStateSnapshotsFromAgentMessages does not mark success text with 'errors' as failure", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:10.000Z",
    messages: [
      {
        role: "tool",
        name: "lint_run",
        content: "Linting complete: 0 errors found. Previously failed test now passes.",
      },
    ],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.kind, "tool");
  assert.equal(snapshots[0]?.outcome, "success");
  assert.equal(snapshots[0]?.changeKind, "observed");
});

test("deriveObjectiveStateSnapshotsFromAgentMessages does not mark failure text with counts as success", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:12.000Z",
    messages: [
      {
        role: "tool",
        name: "build_run",
        content: "Build completed with 3 errors.",
      },
    ],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.outcome, "failure");
  assert.equal(snapshots[0]?.changeKind, "failed");
});

test("deriveObjectiveStateSnapshotsFromAgentMessages treats common error class names as failures", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:13.000Z",
    messages: [
      {
        role: "tool",
        name: "exec_command",
        content: `TypeError: undefined is not a function
NullPointerException at Example.run`,
      },
    ],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.outcome, "failure");
  assert.equal(snapshots[0]?.changeKind, "failed");
});

test("deriveObjectiveStateSnapshotsFromAgentMessages treats timed out phrases as failures", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:14.000Z",
    messages: [
      {
        role: "tool",
        name: "remote_search",
        content: "Request timed out after 30 seconds.",
      },
    ],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.outcome, "failure");
  assert.equal(snapshots[0]?.changeKind, "failed");
});

test("deriveObjectiveStateSnapshotsFromAgentMessages treats negated success phrases as failures", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:14.500Z",
    messages: [
      {
        role: "tool",
        name: "tap_run",
        content: "not ok 1 - objective-state outcome parser regression",
      },
    ],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.outcome, "failure");
  assert.equal(snapshots[0]?.changeKind, "failed");
});

test("recordObjectiveStateSnapshotsFromAgentMessages does not abort on empty generic tool content", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-empty-tool-"));
  const written = await recordObjectiveStateSnapshotsFromAgentMessages({
    memoryDir,
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:15.000Z",
    messages: [
      {
        role: "tool",
        name: "remote_search",
        content: "",
      },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-write",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "workspace/notes.txt",
                content: "hello",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-write",
        name: "write_file",
        content: JSON.stringify({ ok: true }),
      },
    ] as Array<Record<string, unknown>>,
  });

  assert.equal(written.snapshots.length, 2);
  assert.deepEqual(
    written.snapshots.map((snapshot) => [snapshot.kind, snapshot.scope]),
    [
      ["tool", "remote_search"],
      ["file", "workspace/notes.txt"],
    ],
  );
  assert.deepEqual(written.snapshots[0]?.after, { exists: true });

  const status = await getObjectiveStateStoreStatus({
    memoryDir,
    enabled: true,
    writesEnabled: true,
  });
  assert.equal(status.snapshots.total, 2);
  assert.equal(status.snapshots.invalid, 0);
});

test("deriveObjectiveStateSnapshotsFromAgentMessages does not claim failed file writes succeeded", () => {
  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: "agent:main",
    recordedAt: "2026-03-07T12:01:20.000Z",
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-write",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "workspace/failure.txt",
                content: "never landed",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-write",
        name: "write_file",
        content: JSON.stringify({ ok: false, error: "disk full" }),
      },
    ],
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.kind, "file");
  assert.equal(snapshots[0]?.changeKind, "failed");
  assert.deepEqual(snapshots[0]?.after, { ref: "workspace/failure.txt" });
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
