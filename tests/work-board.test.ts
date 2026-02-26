import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { WorkStorage } from "../src/work/storage.js";
import {
  exportWorkBoardMarkdown,
  exportWorkBoardSnapshot,
  importWorkBoardSnapshot,
} from "../src/work/board.js";

test("work board export groups tasks by status and filters by project", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-export-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-board",
    name: "Board project",
  });

  await storage.createTask({
    id: "task-a",
    title: "Alpha",
    status: "todo",
    priority: "high",
    projectId: project.id,
  });
  await storage.createTask({
    id: "task-b",
    title: "Beta",
    status: "in_progress",
    priority: "medium",
    projectId: project.id,
  });
  await storage.createTask({
    id: "task-c",
    title: "Gamma",
    status: "blocked",
    priority: "low",
    projectId: null,
  });

  const markdown = await exportWorkBoardMarkdown({
    memoryDir,
    projectId: project.id,
    now: new Date("2026-02-26T00:00:00.000Z"),
  });

  assert.match(markdown, /^# Work Board/m);
  assert.match(markdown, /Project: Board project \(project-board\)/);
  assert.match(markdown, /## Todo \(1\)/);
  assert.match(markdown, /## In Progress \(1\)/);
  assert.match(markdown, /## Blocked \(0\)/);
  assert.match(markdown, /Alpha/);
  assert.match(markdown, /Beta/);
  assert.doesNotMatch(markdown, /Gamma/);
});

test("work board import creates missing tasks and updates existing tasks", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-import-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-import",
    name: "Import project",
  });

  await storage.createTask({
    id: "task-existing",
    title: "Existing",
    status: "todo",
    priority: "low",
    projectId: project.id,
  });

  const snapshot = await exportWorkBoardSnapshot({
    memoryDir,
    projectId: project.id,
    now: new Date("2026-02-26T00:00:00.000Z"),
  });

  const existing = snapshot.items.find((item) => item.id === "task-existing");
  assert.ok(existing);
  existing.status = "in_progress";
  existing.priority = "high";
  existing.assignee = "agent";

  snapshot.items.push({
    id: "task-new",
    title: "New from import",
    description: "",
    status: "todo",
    priority: "medium",
    owner: null,
    assignee: null,
    projectId: project.id,
    tags: ["imported"],
    dueAt: null,
  });

  const result = await importWorkBoardSnapshot({
    memoryDir,
    snapshot,
    now: new Date("2026-02-27T00:00:00.000Z"),
  });

  assert.deepEqual(result, { created: 1, updated: 1 });

  const updated = await storage.getTask("task-existing");
  assert.ok(updated);
  assert.equal(updated.status, "in_progress");
  assert.equal(updated.priority, "high");
  assert.equal(updated.assignee, "agent");

  const created = await storage.getTask("task-new");
  assert.ok(created);
  assert.equal(created.projectId, project.id);
  assert.deepEqual(created.tags, ["imported"]);
});

test("work board import bypasses transition guardrails for snapshot restores", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-transition-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-transition",
    name: "Transition project",
  });

  await storage.createTask({
    id: "task-restore",
    title: "Restore me",
    status: "done",
    projectId: project.id,
  });

  const snapshot = await exportWorkBoardSnapshot({ memoryDir, projectId: project.id });
  const target = snapshot.items.find((item) => item.id === "task-restore");
  assert.ok(target);
  target.status = "todo";

  const result = await importWorkBoardSnapshot({ memoryDir, snapshot });
  assert.deepEqual(result, { created: 0, updated: 1 });

  const restored = await storage.getTask("task-restore");
  assert.ok(restored);
  assert.equal(restored.status, "todo");
});

test("work board import rejects invalid status/priority values", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-invalid-enum-"));

  await assert.rejects(() =>
    importWorkBoardSnapshot({
      memoryDir,
      snapshot: {
        version: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        projectId: null,
        projectName: null,
        items: [{
          id: "task-bad",
          title: "Bad enum",
          description: "",
          status: "inprogress" as unknown as "todo",
          priority: "urgent" as unknown as "medium",
          owner: null,
          assignee: null,
          projectId: null,
          tags: [],
          dueAt: null,
        }],
      },
    }),
  );
});
