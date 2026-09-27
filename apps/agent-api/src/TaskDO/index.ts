import { createMergeableStore } from "tinybase";
import { createDurableObjectSqlStoragePersister } from "tinybase/persisters/persister-durable-object-sql-storage";
import { WsServerDurableObject } from "tinybase/synchronizers/synchronizer-ws-server-durable-object";
import type { Recurrence } from "@zeroapps/recurrence";

import type { Env } from "../types";
import {
  TaskDomain,
  type AddProjectAfterResult,
  type Project,
  type ProjectDefaults,
  type ProjectState,
  type Task,
  type WaitingCondition,
} from "./domain";

export const TASKDO_SQL_STORAGE_PREFIX = "taskdo_";
export const TASKDO_FIXTURE_DELETED_KEY = "fixtureDeleted";

// The per-account todo authority. It adapts the in-process domain to Durable
// Object persistence, WebSocket synchronization, and account erasure.
export class TaskDO extends WsServerDurableObject<Env> {
  private domain!: TaskDomain;
  private persister!: ReturnType<typeof createDurableObjectSqlStoragePersister>;
  private purging = false;

  override createPersister() {
    const store = createMergeableStore();
    this.persister = createDurableObjectSqlStoragePersister(
      store,
      this.ctx.storage.sql,
      { mode: "fragmented", storagePrefix: TASKDO_SQL_STORAGE_PREFIX },
    );
    this.domain = new TaskDomain({
      store,
      save: async () => { await this.persister.save(); },
      isErased: () => this.isErased(),
    });
    return this.persister;
  }

  isErased(): Promise<boolean> {
    if (this.purging) return Promise.resolve(true);
    return this.ctx.storage.get<boolean>(TASKDO_FIXTURE_DELETED_KEY).then((deleted) => deleted === true);
  }

  listProjects(): Project[] {
    return this.purging ? [] : this.domain.listProjects();
  }

  listProjectRecoveries() {
    return this.purging ? [] : this.domain.listProjectRecoveries();
  }

  addProject(id: string, title: string, opts: ProjectDefaults = {}): Promise<Project | null> {
    return this.domain.addProject(id, title, opts);
  }

  editProject(id: string, fields: { title?: string; icon?: string; description?: string | null }): Promise<Project | null> {
    return this.domain.editProject(id, fields);
  }

  setProjectState(id: string, state: ProjectState): Promise<Project | null> {
    return this.domain.setProjectState(id, state);
  }

  deleteProject(id: string): Promise<{ tasks: number; conditions: number; afters: number }> {
    return this.domain.deleteProject(id);
  }

  listWaitingConditions(): WaitingCondition[] {
    return this.purging ? [] : this.domain.listWaitingConditions();
  }

  listConditionRecoveries() {
    return this.purging ? [] : this.domain.listConditionRecoveries();
  }

  addWaitingCondition(id: string, projectId: string, text: string): Promise<WaitingCondition | null> {
    return this.domain.addWaitingCondition(id, projectId, text);
  }

  addProjectAfter(id: string, projectId: string, refId: string): Promise<AddProjectAfterResult> {
    return this.domain.addProjectAfter(id, projectId, refId);
  }

  resolveWaitingCondition(id: string): Promise<WaitingCondition | null> {
    return this.domain.resolveWaitingCondition(id);
  }

  deleteWaitingCondition(id: string): Promise<void> {
    return this.domain.deleteWaitingCondition(id);
  }

  listTasks(): Task[] {
    return this.purging ? [] : this.domain.listTasks();
  }

  listRecoveries() {
    return this.purging ? [] : this.domain.listRecoveries();
  }

  addTask(id: string, text: string, showUpDate: string | null, projectId: string | null = null,
    recurrence: Recurrence | null = null): Promise<Task | null> {
    return this.domain.addTask(id, text, showUpDate, projectId, recurrence);
  }

  editTask(id: string, text: string): Promise<Task | null> {
    return this.domain.editTask(id, text);
  }

  patchTask(id: string, fields: { text?: string; showUpDate?: string | null;
    sortKey?: string; projectId?: string | null }): Promise<Task | "missing-project" | null> {
    return this.domain.patchTask(id, fields);
  }

  completeTask(id: string): Promise<Task | null> {
    return this.domain.completeTask(id);
  }

  reopenTask(id: string): Promise<Task | null> {
    return this.domain.reopenTask(id);
  }

  setTaskRecurrence(id: string, recurrence: Recurrence | null): Promise<Task | null> {
    return this.domain.setTaskRecurrence(id, recurrence);
  }

  completeTaskOccurrence(id: string, scheduledOn: string, completedOn: string): Promise<Task | "invalid-recurrence" | null> {
    return this.domain.completeTaskOccurrence(id, scheduledOn, completedOn);
  }

  undoTaskOccurrence(id: string, expectedRecurrenceDate: string,
    recurrenceDateBefore: string, showUpDateBefore: string | null): Promise<Task | "invalid-recurrence" | null> {
    return this.domain.undoTaskOccurrence(id, expectedRecurrenceDate, recurrenceDateBefore, showUpDateBefore);
  }

  // The TinyBase synchronizer has live listeners. Stop them and close sockets
  // before deleting SQLite, or a late auto-save can recreate deleted rows.
  async purge(): Promise<void> {
    this.purging = true;
    try {
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Account erased");
      await this.persister.destroy();
      await this.ctx.storage.deleteAll();
      // Keep one bit so an offline client cannot repopulate an erased account.
      await this.ctx.storage.put(TASKDO_FIXTURE_DELETED_KEY, true);
    } catch (error) {
      this.purging = false;
      throw error;
    }
  }

  reset(): void {
    this.ctx.abort("task data deleted");
  }
}
