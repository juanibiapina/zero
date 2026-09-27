import {
  TodoModel,
  type ProjectAfter,
  type ProjectAfterConflict,
  type ProjectDefaults,
  type ProjectState,
  type StoredProject,
  type StoredTask,
  type TodoIssue,
  type WaitingCondition,
} from "@zero/agent-core";
import type { Recurrence } from "@zeroapps/recurrence";
import type { MergeableStore } from "tinybase";

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

type LegacyTodoProvenance = { sourceCaptureId?: string | null };
export type Project = StoredProject & { sourceCaptureId: string | null };
export type Task = StoredTask & { sourceCaptureId: string | null };
export type LegacyProjectCreateOptions = ProjectDefaults & LegacyTodoProvenance;

type TaskDomainOptions = {
  store: MergeableStore;
  save: () => Promise<void>;
  isErased?: () => Promise<boolean>;
  now?: () => Date;
};

// Maps the canonical synchronous model to TaskDO's erasure, durability, and
// RPC result contracts. Todo row rules live in @zero/agent-core.
export class TaskDomain {
  private readonly model: TodoModel;
  private readonly store: MergeableStore;
  private readonly save: () => Promise<void>;
  private readonly isErased: () => Promise<boolean>;

  constructor({ store, save, isErased = async () => false, now = () => new Date() }: TaskDomainOptions) {
    this.store = store;
    this.model = new TodoModel({ store, now });
    this.save = save;
    this.isErased = isErased;
  }

  private async assertActive(message = "Todo account erased"): Promise<void> {
    if (await this.isErased()) throw new Error(message);
  }

  private issues(): TodoIssue[] {
    return this.model.project().issues;
  }

  private projectForLegacyRest(id: string): Project {
    const project = this.model.getProject(id)!;
    const sourceCaptureId = this.store.getCell("projects", id, "sourceCaptureId");
    return { ...project, sourceCaptureId: typeof sourceCaptureId === "string" ? sourceCaptureId : null };
  }

  private taskForLegacyRest(id: string): Task {
    const task = this.model.getTask(id)!;
    const sourceCaptureId = this.store.getCell("tasks", id, "sourceCaptureId");
    return { ...task, sourceCaptureId: typeof sourceCaptureId === "string" ? sourceCaptureId : null };
  }

  listProjects(): Project[] {
    return this.model.project().projects.map((project) => this.projectForLegacyRest(project.id));
  }

  listProjectRecoveries(): ProjectRecovery[] {
    return this.issues().flatMap((issue) =>
      issue.table === "projects" ? [{ projectId: issue.id, reason: issue.reason }] : []);
  }

  async addProject(id: string, title: string, opts: ProjectDefaults = {}): Promise<Project | null> {
    await this.assertActive("Account erased");
    const result = this.model.createProject({ id, title, ...opts });
    if (!result.ok) return null;
    if (result.changed) await this.save();
    return this.projectForLegacyRest(result.value.id);
  }

  async addLegacyProject(
    id: string,
    title: string,
    opts: ProjectDefaults,
    provenance: LegacyTodoProvenance,
  ): Promise<Project | null> {
    await this.assertActive("Account erased");
    const result = this.model.createProject({ id, title, ...opts });
    if (!result.ok) return null;
    if (result.changed && provenance.sourceCaptureId) {
      this.store.setCell("projects", id, "sourceCaptureId", provenance.sourceCaptureId);
    }
    if (result.changed) await this.save();
    return this.projectForLegacyRest(result.value.id);
  }

  async editProject(id: string, fields: { title?: string; icon?: string; description?: string | null }): Promise<Project | null> {
    await this.assertActive();
    const result = this.model.editProject(id, fields);
    if (!result.ok) return null;
    await this.save();
    return this.projectForLegacyRest(result.value.id);
  }

  async setProjectState(id: string, state: ProjectState): Promise<Project | null> {
    await this.assertActive();
    const result = this.model.setProjectState(id, state);
    if (!result.ok) return null;
    if (result.changed) await this.save();
    return this.projectForLegacyRest(result.value.id);
  }

  async deleteProject(id: string): Promise<{ tasks: number; conditions: number; afters: number }> {
    await this.assertActive();
    const result = this.model.deleteProject(id);
    if (!result.ok) throw new Error("unreachable project delete conflict");
    await this.save();
    return result.value;
  }

  listWaitingConditions(): WaitingCondition[] {
    return this.model.project().conditions;
  }

  listConditionRecoveries(): ConditionRecovery[] {
    return this.issues().flatMap((issue) => {
      if (issue.table !== "conditions") return [];
      const reason = issue.reason === "invalid-condition" || issue.reason === "invalid-waiting" || issue.reason === "invalid-after"
        ? "invalid-row" as const
        : issue.reason;
      return [{ conditionId: issue.id, projectId: issue.projectId, refId: issue.refId, reason }];
    });
  }

  async addWaitingCondition(id: string, projectId: string, text: string): Promise<WaitingCondition | null> {
    await this.assertActive();
    const result = this.model.createWaiting(id, projectId, text);
    if (!result.ok) return null;
    if (result.changed) await this.save();
    return result.value;
  }

  async addProjectAfter(id: string, projectId: string, refId: string): Promise<AddProjectAfterResult> {
    await this.assertActive();
    const result = this.model.createAfter(id, projectId, refId);
    if (!result.ok) return { conflict: result.conflict };
    if (result.changed) await this.save();
    return { relationship: result.value };
  }

  async resolveWaitingCondition(id: string): Promise<WaitingCondition | null> {
    await this.assertActive();
    const result = this.model.resolveWaiting(id);
    if (!result.ok) return null;
    if (result.changed) await this.save();
    return result.value;
  }

  async deleteWaitingCondition(id: string): Promise<void> {
    await this.assertActive();
    const result = this.model.deleteCondition(id);
    if (!result.ok) throw new Error("unreachable condition delete conflict");
    if (result.changed) await this.save();
  }

  listTasks(): Task[] {
    return this.model.project({ taskOrder: "manual" }).tasks.map((task) => this.taskForLegacyRest(task.id));
  }

  listRecoveries(): TaskRecovery[] {
    return this.issues().flatMap((issue) =>
      issue.table === "tasks"
        ? [{ taskId: issue.id, projectId: issue.projectId, reason: issue.reason }]
        : []);
  }

  async addTask(id: string, text: string, showUpDate: string | null, projectId: string | null = null,
    recurrence: Recurrence | null = null): Promise<Task | null> {
    await this.assertActive();
    const result = this.model.createTask({ id, text, showUpDate, projectId, recurrence });
    if (!result.ok) return null;
    if (result.changed) await this.save();
    return this.taskForLegacyRest(result.value.id);
  }

  async addLegacyTask(
    id: string,
    text: string,
    showUpDate: string | null,
    projectId: string | null,
    provenance: LegacyTodoProvenance,
    recurrence: Recurrence | null = null,
  ): Promise<Task | null> {
    await this.assertActive();
    const result = this.model.createTask({ id, text, showUpDate, projectId, recurrence });
    if (!result.ok) return null;
    if (result.changed && provenance.sourceCaptureId) {
      this.store.setCell("tasks", id, "sourceCaptureId", provenance.sourceCaptureId);
    }
    if (result.changed) await this.save();
    return this.taskForLegacyRest(result.value.id);
  }

  async editTask(id: string, text: string): Promise<Task | null> {
    await this.assertActive();
    const result = this.model.patchTask(id, { text });
    if (!result.ok) return null;
    await this.save();
    return this.taskForLegacyRest(result.value.id);
  }

  async patchTask(id: string, fields: { text?: string; showUpDate?: string | null;
    sortKey?: string; projectId?: string | null }): Promise<Task | "missing-project" | null> {
    await this.assertActive();
    const result = this.model.patchTask(id, fields);
    if (!result.ok) return result.conflict === "missing-project" ? "missing-project" : null;
    await this.save();
    return this.taskForLegacyRest(result.value.id);
  }

  async completeTask(id: string): Promise<Task | null> {
    await this.assertActive();
    const result = this.model.completeTask(id);
    if (!result.ok) return null;
    if (result.changed) await this.save();
    return this.taskForLegacyRest(result.value.id);
  }

  async reopenTask(id: string): Promise<Task | null> {
    await this.assertActive();
    const result = this.model.reopenTask(id);
    if (!result.ok) return null;
    if (result.changed) await this.save();
    return this.taskForLegacyRest(result.value.id);
  }

  async setTaskRecurrence(id: string, recurrence: Recurrence | null): Promise<Task | null> {
    await this.assertActive();
    const result = this.model.setTaskRecurrence(id, recurrence);
    if (!result.ok) return null;
    await this.save();
    return this.taskForLegacyRest(result.value.id);
  }

  async completeTaskOccurrence(id: string, scheduledOn: string, completedOn: string): Promise<Task | "invalid-recurrence" | null> {
    await this.assertActive();
    const result = this.model.completeOccurrence(id, scheduledOn, completedOn);
    if (!result.ok) return result.conflict === "invalid-recurrence" ? "invalid-recurrence" : null;
    if (result.changed) await this.save();
    return this.taskForLegacyRest(result.value.id);
  }

  async undoTaskOccurrence(id: string, expectedRecurrenceDate: string,
    recurrenceDateBefore: string, showUpDateBefore: string | null): Promise<Task | "invalid-recurrence" | null> {
    await this.assertActive();
    const result = this.model.undoOccurrence(id, expectedRecurrenceDate, recurrenceDateBefore, showUpDateBefore);
    if (!result.ok) return result.conflict === "invalid-recurrence" ? "invalid-recurrence" : null;
    if (result.changed) await this.save();
    return this.taskForLegacyRest(result.value.id);
  }
}

export type {
  ProjectAfter,
  ProjectAfterConflict,
  ProjectDefaults,
  ProjectState,
  WaitingCondition,
} from "@zero/agent-core";
