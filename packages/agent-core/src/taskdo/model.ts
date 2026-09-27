import { advance, validateRecurrence, type Recurrence } from "@zeroapps/recurrence";
import { generateKeyBetween } from "fractional-indexing";
import type { MergeableStore } from "tinybase";

import type {
  Project,
  ProjectAfter,
  ProjectAfterConflict,
  ProjectAttention,
  ProjectState,
  Task,
  TodoIssue,
} from "./types";

export type TodoModelResult<T, Conflict extends string = never> =
  | { ok: true; value: T; changed: boolean }
  | { ok: false; conflict: Conflict };

export type TodoProjection = {
  tasks: Task[];
  projects: Project[];
  conditions: ProjectAttention[];
  issues: TodoIssue[];
};

export type ProjectDefaults = {
  icon?: string;
  description?: string | null;
  state?: ProjectState;
  createdAt?: string;
};

export type TaskInput = {
  id: string;
  text: string;
  showUpDate?: string | null;
  projectId?: string | null;
  recurrence?: Recurrence | null;
  recurrenceDate?: string | null;
  completedAt?: string | null;
  sortKey?: string | null;
  createdAt?: string;
};

export type ProjectInput = ProjectDefaults & { id: string; title: string };

type TodoModelOptions = {
  store: MergeableStore;
  now?: () => Date;
};

const success = <T>(value: T, changed: boolean): TodoModelResult<T> => ({ ok: true, value, changed });
const conflict = <Conflict extends string>(value: Conflict): TodoModelResult<never, Conflict> =>
  ({ ok: false, conflict: value });

function parseRecurrence(raw: unknown): Recurrence | null {
  if (typeof raw !== "string") return null;
  try {
    const result = validateRecurrence(JSON.parse(raw));
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

function put(store: MergeableStore, table: string, id: string, key: string, value: string | boolean | null | undefined) {
  if (value == null) store.delCell(table, id, key);
  else store.setCell(table, id, key, value);
}

export class TodoModel {
  readonly store: MergeableStore;
  private readonly now: () => Date;

  constructor({ store, now = () => new Date() }: TodoModelOptions) {
    this.store = store;
    this.now = now;
  }

  static orderKeyBetween(before: string | null, after: string | null): string {
    return generateKeyBetween(before, after);
  }

  static compareTasks(
    a: { sortKey: string | null; createdAt: string },
    b: { sortKey: string | null; createdAt: string },
  ): number {
    if (a.sortKey == null || b.sortKey == null) {
      if (a.sortKey == null && b.sortKey == null) return a.createdAt.localeCompare(b.createdAt);
      return a.sortKey == null ? 1 : -1;
    }
    return (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0) || a.createdAt.localeCompare(b.createdAt);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  getProject(id: string): Project | null {
    if (!this.store.hasRow("projects", id)) return null;
    const row = this.store.getRow("projects", id);
    if (row.deletedAt || typeof row.title !== "string" || typeof row.createdAt !== "string") return null;
    if (row.state !== "in-play" && row.state !== "backlog" && row.state !== "done") return null;
    return {
      id,
      title: row.title,
      icon: typeof row.icon === "string" ? row.icon : "📁",
      description: typeof row.description === "string" ? row.description : null,
      state: row.state,
      createdAt: row.createdAt,
    };
  }

  getTask(id: string): Task | null {
    if (!this.store.hasRow("tasks", id)) return null;
    const row = this.store.getRow("tasks", id);
    if (typeof row.text !== "string" || typeof row.createdAt !== "string") return null;
    return {
      id,
      text: row.text,
      createdAt: row.createdAt,
      showUpDate: typeof row.showUpDate === "string" ? row.showUpDate : null,
      completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
      recurrence: parseRecurrence(row.recurrence),
      recurrenceDate: typeof row.recurrenceDate === "string" ? row.recurrenceDate : null,
      projectId: typeof row.projectId === "string" && this.getProject(row.projectId) ? row.projectId : null,
      sortKey: typeof row.sortKey === "string" ? row.sortKey : null,
    };
  }

  private getCondition(id: string): ProjectAttention | null {
    if (!this.store.hasRow("conditions", id)) return null;
    const row = this.store.getRow("conditions", id);
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

  private reaches(source: string, destination: string, edges: ProjectAfter[]): boolean {
    const next = new Map<string, string[]>();
    for (const edge of edges) next.set(edge.projectId, [...(next.get(edge.projectId) ?? []), edge.refId]);
    const pending = [source];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === destination) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(next.get(id) ?? []));
    }
    return false;
  }

  private classifyConditions(): { open: ProjectAttention[]; issues: TodoIssue[] } {
    const open: ProjectAttention[] = [];
    const acceptedAfters: ProjectAfter[] = [];
    const issues: TodoIssue[] = [];
    for (const [id, row] of Object.entries(this.store.getTable("conditions")).sort(([a], [b]) => a.localeCompare(b))) {
      const projectId = typeof row.projectId === "string" ? row.projectId : null;
      const refId = typeof row.refId === "string" ? row.refId : null;
      const issue = (reason: Extract<TodoIssue, { table: "conditions" }>["reason"]) =>
        issues.push({ table: "conditions", id, projectId, refId, reason });
      if (!projectId || typeof row.createdAt !== "string" ||
          (row.resolvedAt !== undefined && typeof row.resolvedAt !== "string")) {
        issue("invalid-condition");
        continue;
      }
      if (!this.getProject(projectId)) { issue("missing-source"); continue; }
      if (row.kind === "free-text") {
        if (typeof row.text !== "string" || !row.text.trim() || refId || row.targetStatus) issue("invalid-waiting");
        else if (!row.resolvedAt) open.push({ id, projectId, kind: "free-text", text: row.text,
          refId: null, targetStatus: null, resolvedAt: null, createdAt: row.createdAt });
        continue;
      }
      if (row.kind !== "project-status" || !refId || row.targetStatus !== "done" || row.text) {
        issue("invalid-after");
        continue;
      }
      const target = this.getProject(refId);
      if (!target) { issue("missing-target"); continue; }
      if (projectId === refId) { issue("self"); continue; }
      if (row.resolvedAt) continue;
      if (target.state === "done") { issue("target-done"); continue; }
      if (acceptedAfters.some((edge) => edge.projectId === projectId && edge.refId === refId)) {
        issue("duplicate"); continue;
      }
      if (this.reaches(refId, projectId, acceptedAfters)) { issue("cycle"); continue; }
      const after: ProjectAfter = { id, projectId, kind: "project-status", text: null,
        refId, targetStatus: "done", resolvedAt: null, createdAt: row.createdAt };
      acceptedAfters.push(after);
      open.push(after);
    }
    open.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { open, issues };
  }

  project(options: { taskOrder?: "manual" | "created" } = {}): TodoProjection {
    const issues: TodoIssue[] = [];
    const projects: Project[] = [];
    for (const [id, row] of Object.entries(this.store.getTable("projects"))) {
      if (row.deletedAt) continue;
      const project = this.getProject(id);
      if (project) projects.push(project);
      else issues.push({ table: "projects", id, reason: "invalid-project" });
    }
    const tasks: Task[] = [];
    for (const [id, row] of Object.entries(this.store.getTable("tasks"))) {
      const projectId = typeof row.projectId === "string" ? row.projectId : null;
      if (typeof row.text !== "string" || typeof row.createdAt !== "string") {
        issues.push({ table: "tasks", id, projectId, reason: "invalid-task" });
      }
      if (row.recurrence !== undefined && !parseRecurrence(row.recurrence)) {
        issues.push({ table: "tasks", id, projectId, reason: "invalid-recurrence" });
      }
      if (projectId && !this.getProject(projectId)) {
        const rawProject = this.store.getRow("projects", projectId);
        issues.push({ table: "tasks", id, projectId, reason: rawProject.deletedAt ? "deleted-project" : "missing-project" });
      }
      const task = this.getTask(id);
      if (task && !task.completedAt) tasks.push(task);
    }
    tasks.sort(options.taskOrder === "created"
      ? (a, b) => a.createdAt.localeCompare(b.createdAt)
      : (a, b) => TodoModel.compareTasks(a, b));
    projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const conditions = this.classifyConditions();
    return {
      tasks,
      projects: projects.filter((project) => project.state !== "done"),
      conditions: conditions.open,
      issues: [...issues, ...conditions.issues],
    };
  }

  createProject(input: ProjectInput): TodoModelResult<Project, "id-conflict"> {
    if (this.store.hasRow("projects", input.id)) {
      const existing = this.getProject(input.id);
      return existing ? success(existing, false) : conflict("id-conflict");
    }
    this.store.setRow("projects", input.id, {
      title: input.title,
      icon: input.icon ?? "📁",
      state: input.state ?? "in-play",
      createdAt: input.createdAt ?? this.timestamp(),
      ...(input.description ? { description: input.description } : {}),
    });
    return success(this.getProject(input.id)!, true);
  }

  restoreProject(project: Project): TodoModelResult<Project, "missing-project" | "id-conflict"> {
    if (!this.store.hasRow("projects", project.id)) return this.createProject(project);
    const existing = this.getProject(project.id);
    if (!existing) return conflict("missing-project");
    if (existing.state !== "done") return conflict("id-conflict");
    return this.setProjectState(project.id, project.state);
  }

  editProject(id: string, fields: { title?: string; icon?: string; description?: string | null }): TodoModelResult<Project, "missing-project"> {
    if (!this.getProject(id)) return conflict("missing-project");
    this.store.transaction(() => {
      if (fields.title !== undefined) this.store.setCell("projects", id, "title", fields.title);
      if (fields.icon !== undefined) this.store.setCell("projects", id, "icon", fields.icon);
      if (fields.description !== undefined) put(this.store, "projects", id, "description", fields.description);
    });
    return success(this.getProject(id)!, true);
  }

  setProjectState(id: string, state: ProjectState): TodoModelResult<Project, "missing-project"> {
    const before = this.getProject(id);
    if (!before) return conflict("missing-project");
    if (before.state === state) return success(before, false);
    const now = this.timestamp();
    this.store.transaction(() => {
      this.store.setCell("projects", id, "state", state);
      if (before.state !== "done" && state !== "done") return;
      for (const [conditionId, row] of Object.entries(this.store.getTable("conditions"))) {
        if (row.kind !== "project-status" || row.refId !== id) continue;
        if (state === "done" && !row.resolvedAt) {
          this.store.setCell("conditions", conditionId, "resolvedAt", now);
          this.store.setCell("conditions", conditionId, "settledByTarget", true);
        } else if (before.state === "done" && state !== "done" && row.settledByTarget === true) {
          this.store.delCell("conditions", conditionId, "resolvedAt");
          this.store.delCell("conditions", conditionId, "settledByTarget");
        }
      }
    });
    return success(this.getProject(id)!, true);
  }

  deleteProject(id: string): TodoModelResult<{ tasks: number; conditions: number; afters: number }> {
    let tasks = 0;
    let conditions = 0;
    let afters = 0;
    let changed = false;
    this.store.transaction(() => {
      if (!this.getProject(id)) return;
      changed = true;
      this.store.setCell("projects", id, "deletedAt", this.timestamp());
      for (const [taskId, row] of Object.entries(this.store.getTable("tasks"))) {
        if (row.projectId === id) { this.store.delRow("tasks", taskId); tasks++; }
      }
      for (const [conditionId, row] of Object.entries(this.store.getTable("conditions"))) {
        if (row.projectId === id || row.refId === id) {
          this.store.delRow("conditions", conditionId);
          if (row.kind === "project-status") afters++;
          else conditions++;
        }
      }
    });
    return success({ tasks, conditions, afters }, changed);
  }

  createWaiting(id: string, projectId: string, text: string, createdAt = this.timestamp()): TodoModelResult<ProjectAttention, "id-conflict" | "missing-project"> {
    const existing = this.getCondition(id);
    if (existing) return success(existing, false);
    if (this.store.hasRow("conditions", id)) return conflict("id-conflict");
    if (!this.getProject(projectId)) return conflict("missing-project");
    this.store.setRow("conditions", id, { projectId, kind: "free-text", text, createdAt });
    return success(this.getCondition(id)!, true);
  }

  createAfter(id: string, projectId: string, refId: string, createdAt = this.timestamp()): TodoModelResult<ProjectAfter, ProjectAfterConflict> {
    const existing = this.getCondition(id);
    if (existing?.kind === "project-status" && existing.projectId === projectId && existing.refId === refId) {
      return success(existing, false);
    }
    if (this.store.hasRow("conditions", id)) return conflict("id-conflict");
    if (!this.getProject(projectId)) return conflict("missing-source");
    const target = this.getProject(refId);
    if (!target) return conflict("missing-target");
    if (target.state === "done") return conflict("target-done");
    if (projectId === refId) return conflict("self");
    const afters = this.classifyConditions().open.filter((condition): condition is ProjectAfter => condition.kind === "project-status");
    if (afters.some((after) => after.projectId === projectId && after.refId === refId)) return conflict("duplicate");
    if (this.reaches(refId, projectId, afters)) return conflict("cycle");
    this.store.setRow("conditions", id, { projectId, kind: "project-status", refId, targetStatus: "done", createdAt });
    return success(this.getCondition(id)! as ProjectAfter, true);
  }

  resolveWaiting(id: string): TodoModelResult<ProjectAttention, "missing-condition"> {
    const existing = this.getCondition(id);
    if (!existing) return conflict("missing-condition");
    if (existing.kind !== "free-text" || existing.resolvedAt) return success(existing, false);
    this.store.setCell("conditions", id, "resolvedAt", this.timestamp());
    return success(this.getCondition(id)!, true);
  }

  setConditionResolvedAt(id: string, resolvedAt: string | null): TodoModelResult<ProjectAttention, "missing-condition"> {
    if (!this.getCondition(id)) return conflict("missing-condition");
    put(this.store, "conditions", id, "resolvedAt", resolvedAt);
    return success(this.getCondition(id)!, true);
  }

  deleteCondition(id: string): TodoModelResult<void> {
    if (!this.store.hasRow("conditions", id)) return success(undefined, false);
    this.store.delRow("conditions", id);
    return success(undefined, true);
  }

  createTask(input: TaskInput): TodoModelResult<Task, "id-conflict" | "missing-project"> {
    if (this.store.hasRow("tasks", input.id)) {
      const existing = this.getTask(input.id);
      return existing ? success(existing, false) : conflict("id-conflict");
    }
    if (input.projectId && !this.getProject(input.projectId)) return conflict("missing-project");
    const keys = Object.values(this.store.getTable("tasks"))
      .flatMap((row) => typeof row.sortKey === "string" ? [row.sortKey] : []).sort().reverse();
    let sortKey = TodoModel.orderKeyBetween(null, null);
    for (const key of keys) {
      try { sortKey = TodoModel.orderKeyBetween(key, null); break; } catch { /* Keep malformed synchronized keys raw. */ }
    }
    const recurrenceDate = input.recurrenceDate ?? input.recurrence?.origin ?? null;
    const showUpDate = input.recurrence?.origin ?? input.showUpDate ?? null;
    this.store.setRow("tasks", input.id, {
      text: input.text,
      createdAt: input.createdAt ?? this.timestamp(),
      sortKey: input.sortKey ?? sortKey,
      ...(showUpDate ? { showUpDate } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.recurrence ? { recurrence: JSON.stringify(input.recurrence) } : {}),
      ...(recurrenceDate ? { recurrenceDate } : {}),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    });
    return success(this.getTask(input.id)!, true);
  }

  restoreTask(task: Task): TodoModelResult<Task, "id-conflict" | "missing-project"> {
    if (task.projectId && !this.getProject(task.projectId)) return conflict("missing-project");
    if (!this.store.hasRow("tasks", task.id)) return this.createTask({ ...task, completedAt: null });
    const existing = this.getTask(task.id);
    if (!existing || !existing.completedAt) return conflict("id-conflict");
    this.store.transaction(() => {
      this.store.delCell("tasks", task.id, "completedAt");
      put(this.store, "tasks", task.id, "recurrenceDate", task.recurrenceDate);
      put(this.store, "tasks", task.id, "showUpDate", task.showUpDate);
    });
    return success(this.getTask(task.id)!, true);
  }

  patchTask(id: string, fields: { text?: string; showUpDate?: string | null; sortKey?: string; projectId?: string | null }): TodoModelResult<Task, "missing-task" | "missing-project"> {
    if (!this.getTask(id)) return conflict("missing-task");
    if (fields.projectId && !this.getProject(fields.projectId)) return conflict("missing-project");
    this.store.transaction(() => {
      for (const [key, value] of Object.entries(fields)) put(this.store, "tasks", id, key, value);
    });
    return success(this.getTask(id)!, true);
  }

  updateTask(id: string, fields: Partial<Omit<Task, "id" | "createdAt">>): TodoModelResult<Task, "missing-task" | "missing-project" | "invalid-recurrence"> {
    const task = this.getTask(id);
    if (!task) return conflict("missing-task");
    if (("completedAt" in fields || "recurrenceDate" in fields) &&
        this.store.hasCell("tasks", id, "recurrence") && !task.recurrence) return conflict("invalid-recurrence");
    if (fields.projectId && !this.getProject(fields.projectId)) return conflict("missing-project");
    this.store.transaction(() => {
      for (const [key, value] of Object.entries(fields)) {
        put(this.store, "tasks", id, key, key === "recurrence" && value ? JSON.stringify(value) : value as string | null | undefined);
      }
    });
    return success(this.getTask(id)!, true);
  }

  completeTask(id: string): TodoModelResult<Task, "missing-task"> {
    const task = this.getTask(id);
    if (!task) return conflict("missing-task");
    if (task.completedAt) return success(task, false);
    this.store.setCell("tasks", id, "completedAt", this.timestamp());
    return success(this.getTask(id)!, true);
  }

  reopenTask(id: string): TodoModelResult<Task, "missing-task"> {
    const task = this.getTask(id);
    if (!task) return conflict("missing-task");
    if (!task.completedAt) return success(task, false);
    this.store.delCell("tasks", id, "completedAt");
    return success(this.getTask(id)!, true);
  }

  setTaskRecurrence(id: string, recurrence: Recurrence | null): TodoModelResult<Task, "missing-task"> {
    if (!this.getTask(id)) return conflict("missing-task");
    this.store.transaction(() => {
      put(this.store, "tasks", id, "recurrence", recurrence ? JSON.stringify(recurrence) : null);
      put(this.store, "tasks", id, "recurrenceDate", recurrence?.origin ?? null);
      if (recurrence) this.store.setCell("tasks", id, "showUpDate", recurrence.origin);
    });
    return success(this.getTask(id)!, true);
  }

  planTaskCompletion(task: Task, completedOn: string): Partial<Task> {
    if (task.recurrence && task.recurrenceDate) {
      const next = advance(task.recurrence, { scheduledOn: task.recurrenceDate, completedOn });
      if (next.kind === "next") return { recurrenceDate: next.scheduledOn, showUpDate: next.scheduledOn };
    }
    return { completedAt: this.timestamp() };
  }

  planTaskRecurrence(recurrence: Recurrence | null): Partial<Task> {
    return recurrence
      ? { recurrence, recurrenceDate: recurrence.origin, showUpDate: recurrence.origin }
      : { recurrence: null, recurrenceDate: null };
  }

  completeOccurrence(id: string, scheduledOn: string, completedOn: string): TodoModelResult<Task, "missing-task" | "invalid-recurrence"> {
    const task = this.getTask(id);
    if (!task) return conflict("missing-task");
    if (this.store.hasCell("tasks", id, "recurrence") && !task.recurrence) return conflict("invalid-recurrence");
    if (!task.recurrence || !task.recurrenceDate) return this.completeTask(id);
    if (task.completedAt || task.recurrenceDate !== scheduledOn) return success(task, false);
    const result = advance(task.recurrence, { scheduledOn, completedOn });
    if (result.kind === "finished") return this.completeTask(id);
    this.store.transaction(() => {
      this.store.setCell("tasks", id, "recurrenceDate", result.scheduledOn);
      this.store.setCell("tasks", id, "showUpDate", result.scheduledOn);
    });
    return success(this.getTask(id)!, true);
  }

  undoOccurrence(id: string, expectedRecurrenceDate: string, recurrenceDateBefore: string,
    showUpDateBefore: string | null): TodoModelResult<Task, "missing-task" | "invalid-recurrence"> {
    const task = this.getTask(id);
    if (!task) return conflict("missing-task");
    if (this.store.hasCell("tasks", id, "recurrence") && !task.recurrence) return conflict("invalid-recurrence");
    if (!task.recurrence) return this.reopenTask(id);
    const matchesExpected = task.recurrenceDate === expectedRecurrenceDate;
    const alreadyRestored = task.recurrenceDate === recurrenceDateBefore && !task.completedAt;
    if (!matchesExpected && !alreadyRestored) return success(task, false);
    this.store.transaction(() => {
      this.store.setCell("tasks", id, "recurrenceDate", recurrenceDateBefore);
      put(this.store, "tasks", id, "showUpDate", showUpDateBefore);
      this.store.delCell("tasks", id, "completedAt");
    });
    return success(this.getTask(id)!, true);
  }

  repair(issue: TodoIssue): boolean {
    const current = this.project().issues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(issue));
    if (!current) return false;
    if (issue.table === "tasks" && (issue.reason === "missing-project" || issue.reason === "deleted-project")) {
      this.store.delCell("tasks", issue.id, "projectId");
      return true;
    }
    if (issue.table === "tasks" && issue.reason === "invalid-recurrence") {
      this.store.transaction(() => {
        this.store.delCell("tasks", issue.id, "recurrence");
        this.store.delCell("tasks", issue.id, "recurrenceDate");
      });
      return true;
    }
    if (issue.table === "conditions" && ["missing-target", "target-done", "self", "duplicate", "cycle"].includes(issue.reason)) {
      this.store.delRow("conditions", issue.id);
      return true;
    }
    return false;
  }
}

export type {
  ManualWaitingCondition,
  Project,
  ProjectAfter,
  ProjectAfterConflict,
  ProjectAttention,
  ProjectState,
  Task,
  TodoIssue,
} from "./types";
