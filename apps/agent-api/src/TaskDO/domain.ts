import { advance, validateRecurrence, type PlainDate, type Recurrence } from "@zeroapps/recurrence";
import { generateKeyBetween } from "fractional-indexing";
import type { MergeableStore } from "tinybase";

export interface Task {
  id: string;
  text: string;
  showUpDate: PlainDate | null;
  recurrence: Recurrence | null;
  recurrenceDate: PlainDate | null;
  createdAt: string;
  completedAt: string | null;
  projectId: string | null;
  sourceCaptureId: string | null;
  sortKey: string | null;
}

export type ProjectState = "in-play" | "backlog" | "done";

export interface Project {
  id: string;
  title: string;
  icon: string;
  description: string | null;
  state: ProjectState;
  createdAt: string;
  sourceCaptureId: string | null;
}

export type ProjectDefaults = {
  icon?: string;
  description?: string | null;
  state?: ProjectState;
  sourceCaptureId?: string | null;
};

export type ManualWaitingCondition = {
  id: string;
  projectId: string;
  kind: "free-text";
  text: string;
  refId: null;
  targetStatus: null;
  resolvedAt: string | null;
  createdAt: string;
};

export type ProjectAfter = {
  id: string;
  projectId: string;
  kind: "project-status";
  text: null;
  refId: string;
  targetStatus: "done";
  resolvedAt: string | null;
  createdAt: string;
};

export type WaitingCondition = ManualWaitingCondition | ProjectAfter;

export type ProjectAfterConflict =
  | "id-conflict"
  | "missing-source"
  | "missing-target"
  | "target-done"
  | "self"
  | "duplicate"
  | "cycle";

export type AddProjectAfterResult =
  | { relationship: ProjectAfter }
  | { conflict: ProjectAfterConflict };

export type ConditionRecovery = {
  conditionId: string;
  projectId: string | null;
  refId: string | null;
  reason: "invalid-row" | "missing-source" | "missing-target" | "target-done" | "self" | "duplicate" | "cycle";
};

export type TaskRecovery = {
  taskId: string;
  projectId: string | null;
  reason: "missing-project" | "deleted-project" | "invalid-task" | "invalid-recurrence";
};

export type ProjectRecovery = { projectId: string; reason: "invalid-project" };

type TaskDomainOptions = {
  store: MergeableStore;
  save: () => Promise<void>;
  isErased?: () => Promise<boolean>;
  now?: () => Date;
};

function parseRecurrence(raw: unknown): Recurrence | null {
  if (typeof raw !== "string") return null;
  try {
    const result = validateRecurrence(JSON.parse(raw));
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

// Owns every todo rule that can run against an in-process TinyBase replica.
// Durable Object persistence, synchronization, and erasure remain in TaskDO.
export class TaskDomain {
  private readonly store: MergeableStore;
  private readonly save: () => Promise<void>;
  private readonly isErased: () => Promise<boolean>;
  private readonly now: () => Date;

  constructor({ store, save, isErased = async () => false, now = () => new Date() }: TaskDomainOptions) {
    this.store = store;
    this.save = save;
    this.isErased = isErased;
    this.now = now;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async assertActive(message = "Todo account erased"): Promise<void> {
    if (await this.isErased()) throw new Error(message);
  }

  private project(id: string): Project | null {
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
      sourceCaptureId: typeof row.sourceCaptureId === "string" ? row.sourceCaptureId : null,
    };
  }

  listProjects(): Project[] {
    return Object.keys(this.store.getTable("projects"))
      .map((id) => this.project(id))
      .filter((project): project is Project => project !== null && project.state !== "done")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listProjectRecoveries(): ProjectRecovery[] {
    return Object.entries(this.store.getTable("projects"))
      .filter(([id, row]) => !row.deletedAt && !this.project(id))
      .map(([projectId]) => ({ projectId, reason: "invalid-project" }));
  }

  async addProject(id: string, title: string, opts: ProjectDefaults = {}): Promise<Project | null> {
    await this.assertActive("Account erased");
    if (this.store.hasRow("projects", id)) return this.project(id);
    this.store.setRow("projects", id, {
      title,
      icon: opts.icon ?? "📁",
      state: opts.state ?? "in-play",
      createdAt: this.timestamp(),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.sourceCaptureId ? { sourceCaptureId: opts.sourceCaptureId } : {}),
    });
    await this.save();
    return this.project(id);
  }

  async editProject(id: string, fields: { title?: string; icon?: string; description?: string | null }): Promise<Project | null> {
    await this.assertActive();
    if (!this.project(id)) return null;
    this.store.transaction(() => {
      if (fields.title !== undefined) this.store.setCell("projects", id, "title", fields.title);
      if (fields.icon !== undefined) this.store.setCell("projects", id, "icon", fields.icon);
      if (fields.description !== undefined) {
        if (fields.description === null) this.store.delCell("projects", id, "description");
        else this.store.setCell("projects", id, "description", fields.description);
      }
    });
    await this.save();
    return this.project(id);
  }

  async setProjectState(id: string, state: ProjectState): Promise<Project | null> {
    await this.assertActive();
    const before = this.project(id);
    if (!before) return null;
    if (before.state === state) return before;
    const now = this.timestamp();
    this.store.transaction(() => {
      this.store.setCell("projects", id, "state", state);
      if (before.state === "done" || state === "done") {
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
      }
    });
    await this.save();
    return this.project(id);
  }

  async deleteProject(id: string): Promise<{ tasks: number; conditions: number; afters: number }> {
    await this.assertActive();
    let tasks = 0;
    let conditions = 0;
    let afters = 0;
    this.store.transaction(() => {
      if (!this.project(id)) return;
      this.store.setCell("projects", id, "deletedAt", this.timestamp());
      for (const [taskId, row] of Object.entries(this.store.getTable("tasks"))) {
        if (row.projectId === id) {
          this.store.delRow("tasks", taskId);
          tasks++;
        }
      }
      for (const [conditionId, row] of Object.entries(this.store.getTable("conditions"))) {
        if (row.projectId === id || row.refId === id) {
          this.store.delRow("conditions", conditionId);
          if (row.kind === "project-status") afters++;
          else conditions++;
        }
      }
    });
    await this.save();
    return { tasks, conditions, afters };
  }

  private condition(id: string): WaitingCondition | null {
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

  private projectConditions(): { open: WaitingCondition[]; recoveries: ConditionRecovery[] } {
    const open: WaitingCondition[] = [];
    const acceptedAfters: ProjectAfter[] = [];
    const recoveries: ConditionRecovery[] = [];
    // Stable ordering makes a cycle or duplicate converge to the same accepted
    // subset on all replicas, irrespective of merge or WebSocket arrival order.
    for (const [id, row] of Object.entries(this.store.getTable("conditions")).sort(([a], [b]) => a.localeCompare(b))) {
      const sourceId = typeof row.projectId === "string" ? row.projectId : null;
      const targetId = typeof row.refId === "string" ? row.refId : null;
      const recover = (reason: ConditionRecovery["reason"]) => {
        recoveries.push({ conditionId: id, projectId: sourceId, refId: targetId, reason });
      };
      if (!sourceId || typeof row.createdAt !== "string" ||
          (row.resolvedAt !== undefined && typeof row.resolvedAt !== "string")) {
        recover("invalid-row");
        continue;
      }
      if (!this.project(sourceId)) { recover("missing-source"); continue; }
      if (row.kind === "free-text") {
        if (typeof row.text !== "string" || !row.text.trim() || targetId || row.targetStatus) {
          recover("invalid-row");
        } else if (!row.resolvedAt) {
          open.push({ id, projectId: sourceId, kind: "free-text", text: row.text,
            refId: null, targetStatus: null, resolvedAt: null, createdAt: row.createdAt });
        }
        continue;
      }
      if (row.kind !== "project-status" || !targetId || row.targetStatus !== "done" || row.text) {
        recover("invalid-row");
        continue;
      }
      const target = this.project(targetId);
      if (!target) { recover("missing-target"); continue; }
      if (sourceId === targetId) { recover("self"); continue; }
      if (row.resolvedAt) continue;
      if (target.state === "done") { recover("target-done"); continue; }
      if (acceptedAfters.some((edge) => edge.projectId === sourceId && edge.refId === targetId)) {
        recover("duplicate"); continue;
      }
      if (this.reaches(targetId, sourceId, acceptedAfters)) { recover("cycle"); continue; }
      const after: ProjectAfter = { id, projectId: sourceId, kind: "project-status", text: null,
        refId: targetId, targetStatus: "done", resolvedAt: null, createdAt: row.createdAt };
      acceptedAfters.push(after);
      open.push(after);
    }
    open.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { open, recoveries };
  }

  listWaitingConditions(): WaitingCondition[] {
    return this.projectConditions().open;
  }

  listConditionRecoveries(): ConditionRecovery[] {
    return this.projectConditions().recoveries;
  }

  async addWaitingCondition(id: string, projectId: string, text: string): Promise<WaitingCondition | null> {
    await this.assertActive();
    const existing = this.condition(id);
    if (existing) return existing;
    if (this.store.hasRow("conditions", id) || !this.project(projectId)) return null;
    this.store.setRow("conditions", id, { projectId, kind: "free-text", text, createdAt: this.timestamp() });
    await this.save();
    return this.condition(id);
  }

  async addProjectAfter(id: string, projectId: string, refId: string): Promise<AddProjectAfterResult> {
    await this.assertActive();
    const existing = this.condition(id);
    if (existing?.kind === "project-status" && existing.projectId === projectId && existing.refId === refId) {
      return { relationship: existing };
    }
    if (this.store.hasRow("conditions", id)) return { conflict: "id-conflict" };
    const source = this.project(projectId);
    if (!source) return { conflict: "missing-source" };
    const target = this.project(refId);
    if (!target) return { conflict: "missing-target" };
    if (target.state === "done") return { conflict: "target-done" };
    if (projectId === refId) return { conflict: "self" };
    const afters = this.listWaitingConditions().filter((condition): condition is ProjectAfter => condition.kind === "project-status");
    if (afters.some((after) => after.projectId === projectId && after.refId === refId)) {
      return { conflict: "duplicate" };
    }
    if (this.reaches(refId, projectId, afters)) return { conflict: "cycle" };
    this.store.setRow("conditions", id, {
      projectId, kind: "project-status", refId, targetStatus: "done", createdAt: this.timestamp(),
    });
    await this.save();
    return { relationship: this.condition(id)! as ProjectAfter };
  }

  async resolveWaitingCondition(id: string): Promise<WaitingCondition | null> {
    await this.assertActive();
    const existing = this.condition(id);
    if (!existing || existing.kind !== "free-text" || existing.resolvedAt) return existing;
    this.store.setCell("conditions", id, "resolvedAt", this.timestamp());
    await this.save();
    return this.condition(id);
  }

  async deleteWaitingCondition(id: string): Promise<void> {
    await this.assertActive();
    if (!this.store.hasRow("conditions", id)) return;
    this.store.delRow("conditions", id);
    await this.save();
  }

  private task(id: string): Task | null {
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
      projectId: typeof row.projectId === "string" && this.project(row.projectId) ? row.projectId : null,
      sourceCaptureId: typeof row.sourceCaptureId === "string" ? row.sourceCaptureId : null,
      sortKey: typeof row.sortKey === "string" ? row.sortKey : null,
    };
  }

  listTasks(): Task[] {
    return Object.keys(this.store.getTable("tasks"))
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

  listRecoveries(): TaskRecovery[] {
    return Object.entries(this.store.getTable("tasks")).flatMap(([taskId, row]) => {
      const projectId = typeof row.projectId === "string" ? row.projectId : null;
      const issues: TaskRecovery[] = [];
      if (typeof row.text !== "string" || typeof row.createdAt !== "string") {
        issues.push({ taskId, projectId, reason: "invalid-task" });
      }
      if (row.recurrence !== undefined && !parseRecurrence(row.recurrence)) {
        issues.push({ taskId, projectId, reason: "invalid-recurrence" });
      }
      if (projectId && !this.project(projectId)) {
        const rawProject = this.store.getRow("projects", projectId);
        issues.push({ taskId, projectId, reason: rawProject.deletedAt ? "deleted-project" : "missing-project" });
      }
      return issues;
    });
  }

  async addTask(id: string, text: string, showUpDate: string | null, projectId: string | null = null,
    sourceCaptureId: string | null = null, recurrence: Recurrence | null = null): Promise<Task | null> {
    await this.assertActive();
    const existing = this.task(id);
    if (existing) return existing;
    if (this.store.hasRow("tasks", id) || (projectId !== null && !this.project(projectId))) return null;
    const keys = Object.values(this.store.getTable("tasks"))
      .flatMap((row) => typeof row.sortKey === "string" ? [row.sortKey] : [])
      .sort().reverse();
    let sortKey = generateKeyBetween(null, null);
    for (const key of keys) {
      try { sortKey = generateKeyBetween(key, null); break; }
      catch { /* A raw synced key can be malformed; preserve it for recovery. */ }
    }
    this.store.setRow("tasks", id, {
      text,
      createdAt: this.timestamp(),
      sortKey,
      ...(recurrence?.origin || showUpDate ? { showUpDate: recurrence?.origin ?? showUpDate! } : {}),
      ...(recurrence ? { recurrence: JSON.stringify(recurrence), recurrenceDate: recurrence.origin } : {}),
      ...(sourceCaptureId ? { sourceCaptureId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    await this.save();
    return this.task(id)!;
  }

  async editTask(id: string, text: string): Promise<Task | null> {
    await this.assertActive();
    if (!this.task(id)) return null;
    this.store.setCell("tasks", id, "text", text);
    await this.save();
    return this.task(id);
  }

  async patchTask(id: string, fields: { text?: string; showUpDate?: string | null;
    sortKey?: string; projectId?: string | null }): Promise<Task | "missing-project" | null> {
    await this.assertActive();
    if (!this.task(id)) return null;
    if (fields.projectId && !this.project(fields.projectId)) return "missing-project";
    this.store.transaction(() => {
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) this.store.delCell("tasks", id, key);
        else this.store.setCell("tasks", id, key, value);
      }
    });
    await this.save();
    return this.task(id);
  }

  async completeTask(id: string): Promise<Task | null> {
    await this.assertActive();
    const task = this.task(id);
    if (!task || task.completedAt) return task;
    this.store.setCell("tasks", id, "completedAt", this.timestamp());
    await this.save();
    return this.task(id);
  }

  async reopenTask(id: string): Promise<Task | null> {
    await this.assertActive();
    const task = this.task(id);
    if (!task || !task.completedAt) return task;
    this.store.delCell("tasks", id, "completedAt");
    await this.save();
    return this.task(id);
  }

  async setTaskRecurrence(id: string, recurrence: Recurrence | null): Promise<Task | null> {
    await this.assertActive();
    if (!this.task(id)) return null;
    this.store.transaction(() => {
      if (recurrence) {
        this.store.setCell("tasks", id, "recurrence", JSON.stringify(recurrence));
        this.store.setCell("tasks", id, "recurrenceDate", recurrence.origin);
        this.store.setCell("tasks", id, "showUpDate", recurrence.origin);
      } else {
        this.store.delCell("tasks", id, "recurrence");
        this.store.delCell("tasks", id, "recurrenceDate");
      }
    });
    await this.save();
    return this.task(id);
  }

  async completeTaskOccurrence(id: string, scheduledOn: string, completedOn: string): Promise<Task | "invalid-recurrence" | null> {
    await this.assertActive();
    const task = this.task(id);
    if (!task) return null;
    if (this.store.hasCell("tasks", id, "recurrence") && !task.recurrence) return "invalid-recurrence";
    if (!task.recurrence || !task.recurrenceDate) return this.completeTask(id);
    if (task.completedAt || task.recurrenceDate !== scheduledOn) return task;
    const result = advance(task.recurrence, { scheduledOn, completedOn });
    if (result.kind === "finished") return this.completeTask(id);
    this.store.transaction(() => {
      this.store.setCell("tasks", id, "recurrenceDate", result.scheduledOn);
      this.store.setCell("tasks", id, "showUpDate", result.scheduledOn);
    });
    await this.save();
    return this.task(id);
  }

  async undoTaskOccurrence(id: string, expectedRecurrenceDate: string,
    recurrenceDateBefore: string, showUpDateBefore: string | null): Promise<Task | "invalid-recurrence" | null> {
    await this.assertActive();
    const task = this.task(id);
    if (!task) return null;
    if (this.store.hasCell("tasks", id, "recurrence") && !task.recurrence) return "invalid-recurrence";
    if (!task.recurrence) return this.reopenTask(id);
    const matchesExpected = task.recurrenceDate === expectedRecurrenceDate;
    const alreadyRestored = task.recurrenceDate === recurrenceDateBefore && !task.completedAt;
    if (!matchesExpected && !alreadyRestored) return task;
    this.store.transaction(() => {
      this.store.setCell("tasks", id, "recurrenceDate", recurrenceDateBefore);
      if (showUpDateBefore === null) this.store.delCell("tasks", id, "showUpDate");
      else this.store.setCell("tasks", id, "showUpDate", showUpDateBefore);
      this.store.delCell("tasks", id, "completedAt");
    });
    await this.save();
    return this.task(id);
  }
}
