import { createMergeableStore, type MergeableStore } from "tinybase";
import { createDurableObjectSqlStoragePersister } from "tinybase/persisters/persister-durable-object-sql-storage";
import { WsServerDurableObject } from "tinybase/synchronizers/synchronizer-ws-server-durable-object";
import { advance, validateRecurrence, type Recurrence } from "@zeroapps/recurrence";
import { generateKeyBetween } from "fractional-indexing";

import type { Task } from "../store/tasks";
import type { Project, ProjectDefaults, ProjectState } from "../store/projects";
import type { AddProjectAfterResult } from "../store/project-afters";
import type { WaitingCondition } from "../store/waiting-conditions";
import type { Env } from "../types";
import { projectConditions, reaches } from "./conditions";
import {
  todoSnapshotCounts,
  type TodoSnapshot,
  type TodoSnapshotCounts,
} from "../todo-authority";

const TODO_IMPORT_GENERATION_KEY = "todoImportGeneration";
const TODO_IMPORT_READY_KEY = "todoImportReady";
const TODO_IMPORT_ACTIVE_KEY = "todoImportActive";

function parseRecurrence(raw: unknown): Recurrence | null {
  if (typeof raw !== "string") return null;
  try {
    const result = validateRecurrence(JSON.parse(raw));
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

// The per-account todo authority. A UserDO marker decides when an ordinary
// account is routed here; hermetic fixture accounts use it directly.
export class TaskDO extends WsServerDurableObject<Env> {
  private tasksStore!: MergeableStore;
  private persister!: ReturnType<typeof createDurableObjectSqlStoragePersister>;
  private purging = false;

  override createPersister() {
    this.tasksStore = createMergeableStore();
    this.persister = createDurableObjectSqlStoragePersister(
      this.tasksStore,
      this.ctx.storage.sql,
      { mode: "fragmented", storagePrefix: "taskdo_" },
    );
    return this.persister;
  }

  async importTodos(snapshot: TodoSnapshot): Promise<TodoSnapshotCounts> {
    if (await this.isErased()) throw new Error("Account erased");
    const [generation, ready, active] = await Promise.all([
      this.ctx.storage.get<string>(TODO_IMPORT_GENERATION_KEY),
      this.ctx.storage.get<boolean>(TODO_IMPORT_READY_KEY),
      this.ctx.storage.get<boolean>(TODO_IMPORT_ACTIVE_KEY),
    ]);
    if (active) throw new Error("Todo authority is already active");
    if (generation && generation !== snapshot.generation) {
      throw new Error("A different todo import already exists");
    }
    if (ready) return this.completeCounts();

    const projectIds = new Set(snapshot.projects.map((project) => project.id));
    for (const task of snapshot.tasks) {
      if (task.projectId && !projectIds.has(task.projectId)) {
        throw new Error(`Task ${task.id} references a missing Project`);
      }
    }
    for (const condition of snapshot.conditions) {
      if (!projectIds.has(condition.projectId)) {
        throw new Error(`Condition ${condition.id} references a missing source Project`);
      }
      if (condition.kind === "project-status" && !projectIds.has(condition.refId)) {
        throw new Error(`Condition ${condition.id} references a missing target Project`);
      }
    }

    const cells = (values: Record<string, string | null>) =>
      Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)) as Record<string, string>;
    const projectState = new Map(snapshot.projects.map((project) => [project.id, project.state]));
    this.tasksStore.setTables({
      tasks: Object.fromEntries(snapshot.tasks.map((task) => [task.id, cells({
        text: task.text,
        showUpDate: task.showUpDate,
        recurrence: task.recurrence ? JSON.stringify(task.recurrence) : null,
        recurrenceDate: task.recurrenceDate,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        projectId: task.projectId,
        sourceCaptureId: task.sourceCaptureId,
        sortKey: task.sortKey,
      })])),
      projects: Object.fromEntries(snapshot.projects.map((project) => [project.id, cells({
        title: project.title,
        icon: project.icon,
        description: project.description,
        state: project.state,
        createdAt: project.createdAt,
        sourceCaptureId: project.sourceCaptureId,
      })])),
      conditions: Object.fromEntries(snapshot.conditions.map((condition) => [condition.id, {
        ...cells({
          projectId: condition.projectId,
          kind: condition.kind,
          text: condition.text,
          refId: condition.refId,
          targetStatus: condition.targetStatus,
          resolvedAt: condition.resolvedAt,
          createdAt: condition.createdAt,
        }),
        ...(condition.kind === "project-status" && condition.resolvedAt &&
          projectState.get(condition.refId) === "done" ? { settledByTarget: true } : {}),
      }])),
    });
    await this.persister.save();
    await this.ctx.storage.put({
      [TODO_IMPORT_GENERATION_KEY]: snapshot.generation,
      [TODO_IMPORT_READY_KEY]: true,
    });
    const counts = this.completeCounts();
    const expected = todoSnapshotCounts(snapshot);
    if (JSON.stringify(counts) !== JSON.stringify(expected)) {
      throw new Error("Imported todo counts do not match the frozen source");
    }
    return counts;
  }

  private completeCounts(): TodoSnapshotCounts {
    return {
      tasks: Object.keys(this.tasksStore.getTable("tasks")).length,
      projects: Object.keys(this.tasksStore.getTable("projects")).length,
      conditions: Object.keys(this.tasksStore.getTable("conditions")).length,
    };
  }

  async snapshotImportedTodos(generation: string): Promise<TodoSnapshot> {
    const status = await this.getTodoImportStatus();
    if (status.generation !== generation || !status.ready) {
      throw new Error("Todo import is not ready");
    }
    return {
      generation,
      tasks: Object.keys(this.tasksStore.getTable("tasks"))
        .map((id) => this.task(id))
        .filter((task): task is Task => task !== null),
      projects: Object.keys(this.tasksStore.getTable("projects"))
        .map((id) => this.project(id))
        .filter((project): project is Project => project !== null),
      conditions: Object.keys(this.tasksStore.getTable("conditions"))
        .map((id) => this.condition(id))
        .filter((condition): condition is WaitingCondition => condition !== null),
    };
  }

  async getTodoImportStatus(): Promise<{
    generation: string | null;
    ready: boolean;
    active: boolean;
    counts: TodoSnapshotCounts;
  }> {
    const [generation, ready, active] = await Promise.all([
      this.ctx.storage.get<string>(TODO_IMPORT_GENERATION_KEY),
      this.ctx.storage.get<boolean>(TODO_IMPORT_READY_KEY),
      this.ctx.storage.get<boolean>(TODO_IMPORT_ACTIVE_KEY),
    ]);
    return { generation: generation ?? null, ready: ready === true,
      active: active === true, counts: this.completeCounts() };
  }

  async activateTodoImport(generation: string): Promise<void> {
    const status = await this.getTodoImportStatus();
    if (status.generation !== generation || !status.ready) {
      throw new Error("Todo import is not ready");
    }
    await this.ctx.storage.put(TODO_IMPORT_ACTIVE_KEY, true);
  }

  async discardTodoImport(generation: string): Promise<void> {
    const status = await this.getTodoImportStatus();
    if (status.active) throw new Error("Active todo data cannot be discarded");
    if (status.generation && status.generation !== generation) {
      throw new Error("A different todo import exists");
    }
    this.tasksStore.delTables();
    await this.persister.save();
    await this.ctx.storage.delete([
      TODO_IMPORT_GENERATION_KEY,
      TODO_IMPORT_READY_KEY,
      TODO_IMPORT_ACTIVE_KEY,
    ]);
  }

  isErased(): Promise<boolean> {
    if (this.purging) return Promise.resolve(true);
    return this.ctx.storage.get<boolean>("fixtureDeleted").then((deleted) => deleted === true);
  }

  private project(id: string): Project | null {
    if (!this.tasksStore.hasRow("projects", id)) return null;
    const row = this.tasksStore.getRow("projects", id);
    if (row.deletedAt || typeof row.title !== "string" || typeof row.createdAt !== "string") return null;
    if (row.state !== "in-play" && row.state !== "backlog" && row.state !== "done") return null;
    return {
      id,
      title: row.title,
      icon: typeof row.icon === "string" ? row.icon : "📁",
      description: typeof row.description === "string" ? row.description : null,
      state: row.state,
      createdAt: row.createdAt,
      sourceCaptureId: typeof row.sourceCaptureId === "string" ? row.sourceCaptureId : null,
    };
  }

  listProjects(): Project[] {
    if (this.purging) return [];
    return Object.keys(this.tasksStore.getTable("projects"))
      .map((id) => this.project(id))
      .filter((project): project is Project => project !== null && project.state !== "done")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listProjectRecoveries(): Array<{ projectId: string; reason: "invalid-project" }> {
    if (this.purging) return [];
    return Object.entries(this.tasksStore.getTable("projects"))
      .filter(([id, row]) => !row.deletedAt && !this.project(id))
      .map(([projectId]) => ({ projectId, reason: "invalid-project" }));
  }

  async addProject(id: string, title: string, opts: ProjectDefaults = {}): Promise<Project | null> {
    if (await this.isErased()) throw new Error("Account erased");
    if (this.tasksStore.hasRow("projects", id)) return this.project(id);
    this.tasksStore.setRow("projects", id, {
      title,
      icon: opts.icon ?? "📁",
      state: opts.state ?? "in-play",
      createdAt: new Date().toISOString(),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.sourceCaptureId ? { sourceCaptureId: opts.sourceCaptureId } : {}),
    });
    await this.persister.save();
    return this.project(id);
  }

  async editProject(id: string, fields: { title?: string; icon?: string; description?: string | null }): Promise<Project | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    if (!this.project(id)) return null;
    this.tasksStore.transaction(() => {
      if (fields.title !== undefined) this.tasksStore.setCell("projects", id, "title", fields.title);
      if (fields.icon !== undefined) this.tasksStore.setCell("projects", id, "icon", fields.icon);
      if (fields.description !== undefined) {
        if (fields.description === null) this.tasksStore.delCell("projects", id, "description");
        else this.tasksStore.setCell("projects", id, "description", fields.description);
      }
    });
    await this.persister.save();
    return this.project(id);
  }

  async setProjectState(id: string, state: ProjectState): Promise<Project | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const before = this.project(id);
    if (!before) return null;
    if (before.state === state) return before;
    const now = new Date().toISOString();
    this.tasksStore.transaction(() => {
      this.tasksStore.setCell("projects", id, "state", state);
      if (before.state === "done" || state === "done") {
        for (const [conditionId, row] of Object.entries(this.tasksStore.getTable("conditions"))) {
          if (row.kind !== "project-status" || row.refId !== id) continue;
          if (state === "done" && !row.resolvedAt) {
            this.tasksStore.setCell("conditions", conditionId, "resolvedAt", now);
            this.tasksStore.setCell("conditions", conditionId, "settledByTarget", true);
          } else if (before.state === "done" && state !== "done" && row.settledByTarget === true) {
            this.tasksStore.delCell("conditions", conditionId, "resolvedAt");
            this.tasksStore.delCell("conditions", conditionId, "settledByTarget");
          }
        }
      }
    });
    await this.persister.save();
    return this.project(id);
  }

  async deleteProject(id: string): Promise<{ tasks: number; conditions: number; afters: number }> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    let tasks = 0;
    let conditions = 0;
    let afters = 0;
    this.tasksStore.transaction(() => {
      if (!this.project(id)) return;
      this.tasksStore.setCell("projects", id, "deletedAt", new Date().toISOString());
      for (const [taskId, row] of Object.entries(this.tasksStore.getTable("tasks"))) {
        if (row.projectId === id) {
          this.tasksStore.delRow("tasks", taskId);
          tasks++;
        }
      }
      for (const [conditionId, row] of Object.entries(this.tasksStore.getTable("conditions"))) {
        if (row.projectId === id || row.refId === id) {
          this.tasksStore.delRow("conditions", conditionId);
          if (row.kind === "project-status") afters++;
          else conditions++;
        }
      }
    });
    await this.persister.save();
    return { tasks, conditions, afters };
  }

  private condition(id: string): WaitingCondition | null {
    if (!this.tasksStore.hasRow("conditions", id)) return null;
    const row = this.tasksStore.getRow("conditions", id);
    if (typeof row.projectId !== "string" || typeof row.createdAt !== "string") return null;
    const resolvedAt = typeof row.resolvedAt === "string" ? row.resolvedAt : null;
    if (row.kind === "free-text" && typeof row.text === "string") {
      return { id, projectId: row.projectId, kind: "free-text", text: row.text,
        refId: null, targetStatus: null, resolvedAt, createdAt: row.createdAt };
    }
    if (row.kind === "project-status" && typeof row.refId === "string" && row.targetStatus === "done") {
      return { id, projectId: row.projectId, kind: "project-status", text: null,
        refId: row.refId, targetStatus: "done", resolvedAt, createdAt: row.createdAt };
    }
    return null;
  }

  listWaitingConditions(): WaitingCondition[] {
    if (this.purging) return [];
    return projectConditions(this.tasksStore, (id) => this.project(id)).open;
  }

  listConditionRecoveries() {
    if (this.purging) return [];
    return projectConditions(this.tasksStore, (id) => this.project(id)).recoveries;
  }

  async addWaitingCondition(id: string, projectId: string, text: string): Promise<WaitingCondition | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const existing = this.condition(id);
    if (existing) return existing;
    if (this.tasksStore.hasRow("conditions", id) || !this.project(projectId)) return null;
    this.tasksStore.setRow("conditions", id, { projectId, kind: "free-text", text, createdAt: new Date().toISOString() });
    await this.persister.save();
    return this.condition(id);
  }

  async addProjectAfter(id: string, projectId: string, refId: string): Promise<AddProjectAfterResult> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const existing = this.condition(id);
    if (existing?.kind === "project-status" && existing.projectId === projectId && existing.refId === refId) {
      return { relationship: existing };
    }
    if (this.tasksStore.hasRow("conditions", id)) return { conflict: "id-conflict" };
    const source = this.project(projectId);
    if (!source) return { conflict: "missing-source" };
    const target = this.project(refId);
    if (!target) return { conflict: "missing-target" };
    if (target.state === "done") return { conflict: "target-done" };
    if (projectId === refId) return { conflict: "self" };
    const afters = this.listWaitingConditions().filter((condition) => condition.kind === "project-status");
    if (afters.some((after) => after.projectId === projectId && after.refId === refId)) {
      return { conflict: "duplicate" };
    }
    if (reaches(refId, projectId, afters)) return { conflict: "cycle" };
    this.tasksStore.setRow("conditions", id, {
      projectId, kind: "project-status", refId, targetStatus: "done", createdAt: new Date().toISOString(),
    });
    await this.persister.save();
    return { relationship: this.condition(id)! as Extract<WaitingCondition, { kind: "project-status" }> };
  }

  async resolveWaitingCondition(id: string): Promise<WaitingCondition | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const existing = this.condition(id);
    if (!existing || existing.kind !== "free-text" || existing.resolvedAt) return existing;
    this.tasksStore.setCell("conditions", id, "resolvedAt", new Date().toISOString());
    await this.persister.save();
    return this.condition(id);
  }

  async deleteWaitingCondition(id: string): Promise<void> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    if (!this.tasksStore.hasRow("conditions", id)) return;
    this.tasksStore.delRow("conditions", id);
    await this.persister.save();
  }

  private task(id: string): Task | null {
    if (!this.tasksStore.hasRow("tasks", id)) return null;
    const row = this.tasksStore.getRow("tasks", id);
    if (typeof row.text !== "string" || typeof row.createdAt !== "string") return null;
    return {
      id,
      text: row.text,
      createdAt: row.createdAt,
      showUpDate: typeof row.showUpDate === "string" ? row.showUpDate : null,
      completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
      recurrence: parseRecurrence(row.recurrence),
      recurrenceDate: typeof row.recurrenceDate === "string" ? row.recurrenceDate : null,
      projectId: typeof row.projectId === "string" && this.project(row.projectId) ? row.projectId : null,
      sourceCaptureId: typeof row.sourceCaptureId === "string" ? row.sourceCaptureId : null,
      sortKey: typeof row.sortKey === "string" ? row.sortKey : null,
    };
  }

  listTasks(): Task[] {
    if (this.purging) return [];
    return Object.keys(this.tasksStore.getTable("tasks"))
      .map((id) => this.task(id))
      .filter((task): task is Task => task !== null && task.completedAt === null)
      .sort((a, b) => {
        if (a.sortKey == null || b.sortKey == null) {
          if (a.sortKey == null && b.sortKey == null) return a.createdAt.localeCompare(b.createdAt);
          return a.sortKey == null ? 1 : -1;
        }
        return (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0) || a.createdAt.localeCompare(b.createdAt);
      });
  }

  listRecoveries(): Array<{ taskId: string; projectId: string | null;
    reason: "missing-project" | "deleted-project" | "invalid-task" | "invalid-recurrence" }> {
    if (this.purging) return [];
    return Object.entries(this.tasksStore.getTable("tasks")).flatMap(([taskId, row]) => {
      const projectId = typeof row.projectId === "string" ? row.projectId : null;
      const issues: ReturnType<TaskDO["listRecoveries"]> = [];
      if (typeof row.text !== "string" || typeof row.createdAt !== "string") {
        issues.push({ taskId, projectId, reason: "invalid-task" });
      }
      if (row.recurrence !== undefined && !parseRecurrence(row.recurrence)) {
        issues.push({ taskId, projectId, reason: "invalid-recurrence" });
      }
      if (projectId && !this.project(projectId)) {
        const rawProject = this.tasksStore.getRow("projects", projectId);
        issues.push({ taskId, projectId, reason: rawProject.deletedAt ? "deleted-project" : "missing-project" });
      }
      return issues;
    });
  }

  async addTask(id: string, text: string, showUpDate: string | null, projectId: string | null = null,
    sourceCaptureId: string | null = null, recurrence: Recurrence | null = null): Promise<Task | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const existing = this.task(id);
    if (existing) return existing;
    if (this.tasksStore.hasRow("tasks", id) || (projectId !== null && !this.project(projectId))) return null;
    const keys = Object.values(this.tasksStore.getTable("tasks"))
      .flatMap((row) => typeof row.sortKey === "string" ? [row.sortKey] : [])
      .sort().reverse();
    let sortKey = generateKeyBetween(null, null);
    for (const key of keys) {
      try { sortKey = generateKeyBetween(key, null); break; }
      catch { /* A raw synced key can be malformed; preserve it for recovery. */ }
    }
    this.tasksStore.setRow("tasks", id, {
      text,
      createdAt: new Date().toISOString(),
      sortKey,
      ...(recurrence?.origin || showUpDate ? { showUpDate: recurrence?.origin ?? showUpDate! } : {}),
      ...(recurrence ? { recurrence: JSON.stringify(recurrence), recurrenceDate: recurrence.origin } : {}),
      ...(sourceCaptureId ? { sourceCaptureId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    await this.persister.save();
    return this.task(id)!;
  }

  async editTask(id: string, text: string): Promise<Task | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    if (!this.task(id)) return null;
    this.tasksStore.setCell("tasks", id, "text", text);
    await this.persister.save();
    return this.task(id);
  }

  async patchTask(id: string, fields: { text?: string; showUpDate?: string | null;
    sortKey?: string; projectId?: string | null }): Promise<Task | "missing-project" | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    if (!this.task(id)) return null;
    if (fields.projectId && !this.project(fields.projectId)) return "missing-project";
    this.tasksStore.transaction(() => {
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) this.tasksStore.delCell("tasks", id, key);
        else this.tasksStore.setCell("tasks", id, key, value);
      }
    });
    await this.persister.save();
    return this.task(id);
  }

  async completeTask(id: string): Promise<Task | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const task = this.task(id);
    if (!task || task.completedAt) return task;
    this.tasksStore.setCell("tasks", id, "completedAt", new Date().toISOString());
    await this.persister.save();
    return this.task(id);
  }

  async reopenTask(id: string): Promise<Task | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const task = this.task(id);
    if (!task || !task.completedAt) return task;
    this.tasksStore.delCell("tasks", id, "completedAt");
    await this.persister.save();
    return this.task(id);
  }

  async setTaskRecurrence(id: string, recurrence: Recurrence | null): Promise<Task | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    if (!this.task(id)) return null;
    this.tasksStore.transaction(() => {
      if (recurrence) {
        this.tasksStore.setCell("tasks", id, "recurrence", JSON.stringify(recurrence));
        this.tasksStore.setCell("tasks", id, "recurrenceDate", recurrence.origin);
        this.tasksStore.setCell("tasks", id, "showUpDate", recurrence.origin);
      } else {
        this.tasksStore.delCell("tasks", id, "recurrence");
        this.tasksStore.delCell("tasks", id, "recurrenceDate");
      }
    });
    await this.persister.save();
    return this.task(id);
  }

  async completeTaskOccurrence(id: string, scheduledOn: string, completedOn: string): Promise<Task | "invalid-recurrence" | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const task = this.task(id);
    if (!task) return null;
    if (this.tasksStore.hasCell("tasks", id, "recurrence") && !task.recurrence) return "invalid-recurrence";
    if (!task.recurrence || !task.recurrenceDate) return this.completeTask(id);
    if (task.completedAt || task.recurrenceDate !== scheduledOn) return task;
    const result = advance(task.recurrence, { scheduledOn, completedOn });
    if (result.kind === "finished") return this.completeTask(id);
    this.tasksStore.transaction(() => {
      this.tasksStore.setCell("tasks", id, "recurrenceDate", result.scheduledOn);
      this.tasksStore.setCell("tasks", id, "showUpDate", result.scheduledOn);
    });
    await this.persister.save();
    return this.task(id);
  }

  async undoTaskOccurrence(id: string, expectedRecurrenceDate: string,
    recurrenceDateBefore: string, showUpDateBefore: string | null): Promise<Task | "invalid-recurrence" | null> {
    if (await this.isErased()) throw new Error("Fixture account erased");
    const task = this.task(id);
    if (!task) return null;
    if (this.tasksStore.hasCell("tasks", id, "recurrence") && !task.recurrence) return "invalid-recurrence";
    if (!task.recurrence) return this.reopenTask(id);
    const matchesExpected = task.recurrenceDate === expectedRecurrenceDate;
    const alreadyRestored = task.recurrenceDate === recurrenceDateBefore && !task.completedAt;
    if (!matchesExpected && !alreadyRestored) return task;
    this.tasksStore.transaction(() => {
      this.tasksStore.setCell("tasks", id, "recurrenceDate", recurrenceDateBefore);
      if (showUpDateBefore === null) this.tasksStore.delCell("tasks", id, "showUpDate");
      else this.tasksStore.setCell("tasks", id, "showUpDate", showUpDateBefore);
      this.tasksStore.delCell("tasks", id, "completedAt");
    });
    await this.persister.save();
    return this.task(id);
  }

  // The TinyBase synchronizer has live listeners. Stop them and close sockets
  // before deleting SQLite, or a late auto-save can recreate deleted rows.
  async purge(lockFixture = false): Promise<void> {
    this.purging = true;
    try {
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Account erased");
      await this.persister.destroy();
      await this.ctx.storage.deleteAll();
      // Ordinary accounts have no TaskDO client yet. The fixture must keep
      // this one bit or an offline client could repopulate deleted Tasks.
      if (lockFixture) await this.ctx.storage.put("fixtureDeleted", true);
    } catch (error) {
      this.purging = false;
      throw error;
    }
  }

  reset(): void {
    this.ctx.abort("task data deleted");
  }
}
