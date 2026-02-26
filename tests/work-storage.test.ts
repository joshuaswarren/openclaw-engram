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
});

test("work storage project CRUD and task linkage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-storage-project-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    name: "v8.7 Work Layer",
    owner: "eng",
    tags: ["v8.7"],
  });
  const task = await storage.createTask({ title: "Model storage", owner: "eng" });

  const linked = await storage.linkTaskToProject(task.id, project.id);
  assert.equal(linked.task.projectId, project.id);
  assert.deepEqual(linked.project.taskIds, [task.id]);

  const fetchedProject = await storage.getProject(project.id);
  assert.ok(fetchedProject);
  assert.deepEqual(fetchedProject?.taskIds, [task.id]);

  const projects = await storage.listProjects();
  assert.equal(projects.length, 1);

  const updatedProject = await storage.updateProject(project.id, { status: "on_hold", description: "blocked" });
  assert.equal(updatedProject?.status, "on_hold");
  assert.equal(updatedProject?.description, "blocked");

  const removed = await storage.deleteProject(project.id);
  assert.equal(removed, true);
  assert.equal(await storage.getProject(project.id), null);
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
