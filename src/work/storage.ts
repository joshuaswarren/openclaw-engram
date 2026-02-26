import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type {
  CreateWorkProjectInput,
  CreateWorkTaskInput,
  UpdateWorkProjectInput,
  UpdateWorkTaskInput,
  WorkProject,
  WorkProjectStatus,
  WorkTask,
  WorkTaskListFilter,
  WorkTaskStatus,
} from "./types.js";

const TASK_TRANSITIONS: Record<WorkTaskStatus, Set<WorkTaskStatus>> = {
  todo: new Set(["in_progress", "blocked", "cancelled"]),
  in_progress: new Set(["todo", "blocked", "done", "cancelled"]),
  blocked: new Set(["todo", "in_progress", "cancelled"]),
  done: new Set(),
  cancelled: new Set(),
};

function serializeFrontmatter(values: object): string {
  const lines = Object.entries(values).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---`;
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const fm = match[1] ?? "";
  const body = match[2] ?? "";
  const data: Record<string, unknown> = {};
  for (const line of fm.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    try {
      data[key] = JSON.parse(rawValue);
    } catch {
      data[key] = rawValue;
    }
  }
  return { data, body };
}

function toSafeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 80);
}

const WORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function makeId(prefix: string, titleOrName: string, now: Date): string {
  const slug = toSafeSlug(titleOrName) || "item";
  const nonce = randomUUID().slice(0, 8);
  return `${prefix}-${now.getTime()}-${slug}-${nonce}`;
}

function assertValidWorkId(id: string, kind: "task" | "project"): void {
  if (!WORK_ID_PATTERN.test(id)) {
    throw new Error(`invalid ${kind} id: ${id}`);
  }
}

function ensureString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string");
}

function ensureNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function ensureTaskStatus(value: unknown): WorkTaskStatus {
  if (value === "todo" || value === "in_progress" || value === "blocked" || value === "done" || value === "cancelled") {
    return value;
  }
  return "todo";
}

function ensureTaskPriority(value: unknown): WorkTask["priority"] {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function ensureProjectStatus(value: unknown): WorkProjectStatus {
  if (value === "active" || value === "on_hold" || value === "completed" || value === "archived") return value;
  return "active";
}

export class WorkStorage {
  private readonly tasksDir: string;
  private readonly projectsDir: string;

  constructor(private readonly memoryDir: string) {
    this.tasksDir = path.join(memoryDir, "work", "tasks");
    this.projectsDir = path.join(memoryDir, "work", "projects");
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    await mkdir(this.projectsDir, { recursive: true });
  }

  private taskPath(id: string): string {
    assertValidWorkId(id, "task");
    return path.join(this.tasksDir, `${id}.md`);
  }

  private projectPath(id: string): string {
    assertValidWorkId(id, "project");
    return path.join(this.projectsDir, `${id}.md`);
  }

  private serializeTask(task: WorkTask): string {
    return `${serializeFrontmatter(task)}\n\n${task.description}\n`;
  }

  private serializeProject(project: WorkProject): string {
    return `${serializeFrontmatter(project)}\n\n${project.description}\n`;
  }

  private parseTask(raw: string): WorkTask | null {
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    const d = parsed.data;
    return {
      id: ensureString(d.id),
      title: ensureString(d.title),
      description: ensureString(d.description, parsed.body.trim()),
      status: ensureTaskStatus(d.status),
      priority: ensureTaskPriority(d.priority),
      owner: ensureNullableString(d.owner),
      assignee: ensureNullableString(d.assignee),
      projectId: ensureNullableString(d.projectId),
      tags: ensureStringArray(d.tags),
      dueAt: ensureNullableString(d.dueAt),
      createdAt: ensureString(d.createdAt),
      updatedAt: ensureString(d.updatedAt),
    };
  }

  private parseProject(raw: string): WorkProject | null {
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    const d = parsed.data;
    return {
      id: ensureString(d.id),
      name: ensureString(d.name),
      description: ensureString(d.description, parsed.body.trim()),
      status: ensureProjectStatus(d.status),
      owner: ensureNullableString(d.owner),
      tags: ensureStringArray(d.tags),
      taskIds: ensureStringArray(d.taskIds),
      createdAt: ensureString(d.createdAt),
      updatedAt: ensureString(d.updatedAt),
    };
  }

  async createTask(input: CreateWorkTaskInput, now = new Date()): Promise<WorkTask> {
    await this.ensureDirectories();
    const timestamp = now.toISOString();
    const task: WorkTask = {
      id: input.id ?? makeId("task", input.title, now),
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      owner: input.owner ?? null,
      assignee: input.assignee ?? null,
      projectId: input.projectId ?? null,
      tags: input.tags ?? [],
      dueAt: input.dueAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (task.projectId) {
      const project = await this.getProject(task.projectId);
      if (!project) {
        throw new Error(`project not found: ${task.projectId}`);
      }
    }

    await writeFile(this.taskPath(task.id), this.serializeTask(task), "utf-8");

    if (task.projectId) {
      await this.addTaskIdToProject(task.projectId, task.id, now);
    }

    return task;
  }

  async getTask(id: string): Promise<WorkTask | null> {
    try {
      const raw = await readFile(this.taskPath(id), "utf-8");
      return this.parseTask(raw);
    } catch {
      return null;
    }
  }

  async listTasks(filter?: WorkTaskListFilter): Promise<WorkTask[]> {
    await this.ensureDirectories();
    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    const out: WorkTask[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const raw = await readFile(path.join(this.tasksDir, entry.name), "utf-8");
      const task = this.parseTask(raw);
      if (!task) continue;
      if (filter?.status && task.status !== filter.status) continue;
      if (filter?.owner && task.owner !== filter.owner) continue;
      if (filter?.assignee && task.assignee !== filter.assignee) continue;
      if (filter?.projectId && task.projectId !== filter.projectId) continue;
      out.push(task);
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  async updateTask(
    id: string,
    patch: UpdateWorkTaskInput,
    now = new Date(),
    options?: { skipStatusTransitionValidation?: boolean },
  ): Promise<WorkTask | null> {
    const existing = await this.getTask(id);
    if (!existing) return null;

    const projectIdPatched = Object.prototype.hasOwnProperty.call(patch, "projectId");
    const statusPatched = Object.prototype.hasOwnProperty.call(patch, "status");
    const nextProjectId = projectIdPatched ? patch.projectId ?? null : existing.projectId;

    if (
      statusPatched
      && patch.status
      && existing.status !== patch.status
      && options?.skipStatusTransitionValidation !== true
      && !TASK_TRANSITIONS[existing.status].has(patch.status)
    ) {
      throw new Error(`invalid task status transition: ${existing.status} -> ${patch.status}`);
    }

    if (projectIdPatched && nextProjectId) {
      const nextProject = await this.getProject(nextProjectId);
      if (!nextProject) {
        throw new Error(`project not found: ${nextProjectId}`);
      }
    }

    if (projectIdPatched && existing.projectId !== nextProjectId) {
      if (existing.projectId) {
        await this.removeTaskIdFromProject(existing.projectId, id, now);
      }
      if (nextProjectId) {
        await this.addTaskIdToProject(nextProjectId, id, now);
      }
    }

    const next: WorkTask = {
      ...existing,
      ...patch,
      projectId: nextProjectId,
      tags: patch.tags ?? existing.tags,
      updatedAt: now.toISOString(),
    };
    await writeFile(this.taskPath(id), this.serializeTask(next), "utf-8");
    return next;
  }

  async transitionTask(id: string, nextStatus: WorkTaskStatus, now = new Date()): Promise<WorkTask> {
    const existing = await this.getTask(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    if (existing.status === nextStatus) return existing;
    if (!TASK_TRANSITIONS[existing.status].has(nextStatus)) {
      throw new Error(`invalid task status transition: ${existing.status} -> ${nextStatus}`);
    }
    const updated = await this.updateTask(id, { status: nextStatus }, now);
    if (!updated) throw new Error(`task not found after update: ${id}`);
    return updated;
  }

  async deleteTask(id: string): Promise<boolean> {
    try {
      const existing = await this.getTask(id);
      await rm(this.taskPath(id));
      if (existing?.projectId) {
        await this.removeTaskIdFromProject(existing.projectId, id);
      }
      return true;
    } catch {
      return false;
    }
  }

  async createProject(input: CreateWorkProjectInput, now = new Date()): Promise<WorkProject> {
    await this.ensureDirectories();
    const timestamp = now.toISOString();
    const project: WorkProject = {
      id: input.id ?? makeId("project", input.name, now),
      name: input.name,
      description: input.description ?? "",
      status: input.status ?? "active",
      owner: input.owner ?? null,
      tags: input.tags ?? [],
      taskIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeFile(this.projectPath(project.id), this.serializeProject(project), "utf-8");
    return project;
  }

  async getProject(id: string): Promise<WorkProject | null> {
    try {
      const raw = await readFile(this.projectPath(id), "utf-8");
      return this.parseProject(raw);
    } catch {
      return null;
    }
  }

  async listProjects(): Promise<WorkProject[]> {
    await this.ensureDirectories();
    const entries = await readdir(this.projectsDir, { withFileTypes: true });
    const out: WorkProject[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const raw = await readFile(path.join(this.projectsDir, entry.name), "utf-8");
      const project = this.parseProject(raw);
      if (project) out.push(project);
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  async updateProject(id: string, patch: UpdateWorkProjectInput, now = new Date()): Promise<WorkProject | null> {
    const existing = await this.getProject(id);
    if (!existing) return null;
    const next: WorkProject = {
      ...existing,
      ...patch,
      tags: patch.tags ?? existing.tags,
      taskIds: patch.taskIds ? [...patch.taskIds].sort() : existing.taskIds,
      updatedAt: now.toISOString(),
    };
    await writeFile(this.projectPath(id), this.serializeProject(next), "utf-8");
    return next;
  }

  async deleteProject(id: string): Promise<boolean> {
    try {
      const existing = await this.getProject(id);
      if (existing) {
        for (const taskId of existing.taskIds) {
          await this.updateTask(taskId, { projectId: null });
        }
      }
      await rm(this.projectPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async linkTaskToProject(taskId: string, projectId: string, now = new Date()): Promise<{ task: WorkTask; project: WorkProject }> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const project = await this.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);

    const updatedTask = await this.updateTask(taskId, { projectId }, now);
    if (!updatedTask) throw new Error(`task not found after update: ${taskId}`);

    const updatedProject = await this.getProject(projectId);
    if (!updatedProject) throw new Error(`project not found after update: ${projectId}`);

    return { task: updatedTask, project: updatedProject };
  }

  private async removeTaskIdFromProject(projectId: string, taskId: string, now = new Date()): Promise<void> {
    const project = await this.getProject(projectId);
    if (!project) return;

    const filtered = project.taskIds.filter((id) => id !== taskId);
    if (filtered.length === project.taskIds.length) return;

    await this.updateProject(projectId, { taskIds: filtered }, now);
  }

  private async addTaskIdToProject(projectId: string, taskId: string, now = new Date()): Promise<void> {
    const project = await this.getProject(projectId);
    if (!project) return;

    const taskIds = new Set(project.taskIds);
    taskIds.add(taskId);
    await this.updateProject(projectId, { taskIds: Array.from(taskIds) }, now);
  }
}
