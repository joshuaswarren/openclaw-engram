import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  runWorkProjectCliCommand,
  runWorkTaskCliCommand,
} from "../src/cli.js";

test("work task CLI wrapper supports create/list/transition/update/delete", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-work-task-"));

  const created = await runWorkTaskCliCommand({
    memoryDir,
    action: "create",
    title: "Ship task CLI",
    status: "todo",
    priority: "high",
    owner: "eng",
    tags: ["v8.7", "cli"],
  });
  assert.equal(typeof (created as { id?: string }).id, "string");

  const taskId = (created as { id: string }).id;
  const listed = await runWorkTaskCliCommand({
    memoryDir,
    action: "list",
    status: "todo",
  });
  assert.equal(Array.isArray(listed), true);
  assert.equal((listed as Array<{ id: string }>).some((item) => item.id === taskId), true);

  const transitioned = await runWorkTaskCliCommand({
    memoryDir,
    action: "transition",
    id: taskId,
    status: "in_progress",
  });
  assert.equal((transitioned as { status: string }).status, "in_progress");

  const updated = await runWorkTaskCliCommand({
    memoryDir,
    action: "update",
    id: taskId,
    patch: {
      assignee: "agent-1",
      status: "blocked",
    },
  });
  assert.equal((updated as { assignee: string | null }).assignee, "agent-1");
  assert.equal((updated as { status: string }).status, "blocked");

  const removed = await runWorkTaskCliCommand({
    memoryDir,
    action: "delete",
    id: taskId,
  });
  assert.equal(removed, true);
});

test("work project CLI wrapper supports create/get/list/update/delete", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-work-project-"));

  const created = await runWorkProjectCliCommand({
    memoryDir,
    action: "create",
    name: "v8.7 CLI",
    status: "active",
    owner: "eng",
    tags: ["v8.7"],
  });
  const projectId = (created as { id: string }).id;

  const got = await runWorkProjectCliCommand({
    memoryDir,
    action: "get",
    id: projectId,
  });
  assert.equal((got as { name: string }).name, "v8.7 CLI");

  const listed = await runWorkProjectCliCommand({
    memoryDir,
    action: "list",
  });
  assert.equal(Array.isArray(listed), true);
  assert.equal((listed as Array<{ id: string }>).length, 1);

  const updated = await runWorkProjectCliCommand({
    memoryDir,
    action: "update",
    id: projectId,
    patch: {
      status: "on_hold",
      description: "blocked",
    },
  });
  assert.equal((updated as { status: string }).status, "on_hold");

  const removed = await runWorkProjectCliCommand({
    memoryDir,
    action: "delete",
    id: projectId,
  });
  assert.equal(removed, true);
});

test("work CLI wrappers maintain task/project linkage and validate transitions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-work-linkage-"));

  const project = await runWorkProjectCliCommand({
    memoryDir,
    action: "create",
    name: "Linkage",
  });
  const projectId = (project as { id: string }).id;

  const createdTask = await runWorkTaskCliCommand({
    memoryDir,
    action: "create",
    title: "Linked task",
    projectId,
  });
  const taskId = (createdTask as { id: string }).id;

  const fetchedProject = await runWorkProjectCliCommand({
    memoryDir,
    action: "get",
    id: projectId,
  });
  assert.equal((fetchedProject as { taskIds: string[] }).taskIds.includes(taskId), true);

  await runWorkTaskCliCommand({
    memoryDir,
    action: "transition",
    id: taskId,
    status: "in_progress",
  });
  await runWorkTaskCliCommand({
    memoryDir,
    action: "transition",
    id: taskId,
    status: "done",
  });
  await assert.rejects(() =>
    runWorkTaskCliCommand({
      memoryDir,
      action: "update",
      id: taskId,
      patch: { status: "todo" },
    }),
  );

  await runWorkProjectCliCommand({
    memoryDir,
    action: "delete",
    id: projectId,
  });
  const orphanedTask = await runWorkTaskCliCommand({
    memoryDir,
    action: "get",
    id: taskId,
  });
  assert.equal((orphanedTask as { projectId: string | null }).projectId, null);
});
