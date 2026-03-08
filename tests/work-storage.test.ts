import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { WorkStorage } from "../src/work/storage.js";

test("work storage task CRUD persists owner and status metadata", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-task-"));
  const storage = new WorkStorage(memoryDir);

  const created = await storage.createTask({
    title: "Ship v8.7 task storage",
    owner: "eng",
    assignee: "agent-1",
    tags: ["v8.7", "work"],
    priority: "high",
  });

  assert.equal(created.status, "todo");
  assert.equal(created.owner, "eng");
  assert.equal(created.assignee, "agent-1");

  const fetched = await storage.getTask(created.id);
  assert.ok(fetched);
  assert.equal(fetched?.title, "Ship v8.7 task storage");
  assert.deepEqual(fetched?.tags, ["v8.7", "work"]);

  const updated = await storage.updateTask(created.id, { status: "in_progress", owner: "platform" });
  assert.ok(updated);
  assert.equal(updated?.status, "in_progress");
  assert.equal(updated?.owner, "platform");

  const listed = await storage.listTasks({ status: "in_progress" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);

  const removed = await storage.deleteTask(created.id);
  assert.equal(removed, true);
  assert.equal(await storage.getTask(created.id), null);
});

test("work storage enforces valid status transitions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-transitions-"));
  const storage = new WorkStorage(memoryDir);

  const task = await storage.createTask({ title: "Transition me" });
  const progressed = await storage.transitionTask(task.id, "in_progress");
  assert.equal(progressed.status, "in_progress");

  const done = await storage.transitionTask(task.id, "done");
  assert.equal(done.status, "done");

  await assert.rejects(() => storage.transitionTask(task.id, "todo"));
  await assert.rejects(() => storage.updateTask(task.id, { status: "todo" }));
});

test("work storage project CRUD and task linkage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-project-"));
  const storage = new WorkStorage(memoryDir);

  const projectA = await storage.createProject({
    name: "v8.7 Work Layer",
    owner: "eng",
    tags: ["v8.7"],
  });
  const projectB = await storage.createProject({
    name: "v8.7 Followup",
    owner: "eng",
  });
  const task = await storage.createTask({ title: "Model storage", owner: "eng" });
  const createLinked = await storage.createTask({ title: "Created linked", projectId: projectA.id });

  const linkedA = await storage.linkTaskToProject(task.id, projectA.id);
  assert.equal(linkedA.task.projectId, projectA.id);
  assert.deepEqual(linkedA.project.taskIds, [createLinked.id, task.id].sort());

  const linkedB = await storage.linkTaskToProject(task.id, projectB.id);
  assert.equal(linkedB.task.projectId, projectB.id);
  assert.deepEqual(linkedB.project.taskIds, [task.id]);

  const fetchedProjectA = await storage.getProject(projectA.id);
  const fetchedProjectB = await storage.getProject(projectB.id);
  assert.ok(fetchedProjectA);
  assert.ok(fetchedProjectB);
  assert.deepEqual(fetchedProjectA?.taskIds, [createLinked.id]);
  assert.deepEqual(fetchedProjectB?.taskIds, [task.id]);

  const taskRemoved = await storage.deleteTask(task.id);
  assert.equal(taskRemoved, true);
  const projectBAfterDelete = await storage.getProject(projectB.id);
  assert.ok(projectBAfterDelete);
  assert.deepEqual(projectBAfterDelete?.taskIds, []);

  await assert.rejects(() => storage.createTask({ title: "bad link", projectId: "project-missing" }), /project not found/);

  const projects = await storage.listProjects();
  assert.equal(projects.length, 2);

  const updatedProject = await storage.updateProject(projectA.id, { status: "on_hold", description: "blocked" });
  assert.equal(updatedProject?.status, "on_hold");
  assert.equal(updatedProject?.description, "blocked");

  const removed = await storage.deleteProject(projectA.id);
  assert.equal(removed, true);
  assert.equal(await storage.getProject(projectA.id), null);
});

test("work storage keeps project index in sync when patching task projectId", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-patch-project-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({ name: "Patch Project" });
  const task = await storage.createTask({ title: "Patchable task" });

  const linked = await storage.updateTask(task.id, { projectId: project.id });
  assert.equal(linked?.projectId, project.id);

  const withLink = await storage.getProject(project.id);
  assert.ok(withLink);
  assert.deepEqual(withLink?.taskIds, [task.id]);

  const unlinked = await storage.updateTask(task.id, { projectId: null });
  assert.equal(unlinked?.projectId, null);

  const cleared = await storage.getProject(project.id);
  assert.ok(cleared);
  assert.deepEqual(cleared?.taskIds, []);
});

test("work storage clears task links when deleting a project", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-delete-project-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({ name: "Disposable project" });
  const task = await storage.createTask({ title: "Linked task" });
  await storage.linkTaskToProject(task.id, project.id);

  const removed = await storage.deleteProject(project.id);
  assert.equal(removed, true);

  const orphaned = await storage.getTask(task.id);
  assert.ok(orphaned);
  assert.equal(orphaned?.projectId, null);
});

test("work storage generates collision-resistant ids for same timestamp/title", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-id-collision-"));
  const storage = new WorkStorage(memoryDir);

  const fixedNow = new Date("2026-02-26T00:00:00.000Z");
  const first = await storage.createTask({ title: "Same title" }, fixedNow);
  const second = await storage.createTask({ title: "Same title" }, fixedNow);

  assert.notEqual(first.id, second.id);
  const tasks = await storage.listTasks();
  assert.equal(tasks.length, 2);
});

test("work storage rejects unsafe task and project IDs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-safe-id-"));
  const storage = new WorkStorage(memoryDir);

  await assert.rejects(() => storage.createTask({ id: "../escape", title: "bad" }), /invalid task id/);
  await assert.rejects(() => storage.createProject({ id: "../escape", name: "bad" }), /invalid project id/);

  assert.equal(await storage.getTask("../escape"), null);
  assert.equal(await storage.getProject("../escape"), null);
});

test("work storage uses markdown frontmatter files for persisted work artifacts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-frontmatter-"));
  const storage = new WorkStorage(memoryDir);

  const task = await storage.createTask({ title: "Frontmatter check", description: "body" });
  const project = await storage.createProject({ name: "Frontmatter Project" });

  const taskPath = path.join(memoryDir, "work", "tasks", `${task.id}.md`);
  const projectPath = path.join(memoryDir, "work", "projects", `${project.id}.md`);

  await stat(taskPath);
  await stat(projectPath);

  const taskRaw = await readFile(taskPath, "utf-8");
  const projectRaw = await readFile(projectPath, "utf-8");
  assert.ok(taskRaw.startsWith("---\n"));
  assert.ok(projectRaw.startsWith("---\n"));
  assert.ok(taskRaw.includes("\n---\n\n"));
  assert.ok(projectRaw.includes("\n---\n\n"));
});
