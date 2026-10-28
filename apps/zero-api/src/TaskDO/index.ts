import { createMergeableStore } from "tinybase";
import { createDurableObjectSqlStoragePersister } from "tinybase/persisters/persister-durable-object-sql-storage";
import { WsServerDurableObject } from "tinybase/synchronizers/synchronizer-ws-server-durable-object";
import type { OperationOutcome } from "@zero/agent-core/operations";
import type { Recurrence } from "@zeroapps/recurrence";

import { reportError } from "../reporting/zero-errors";
import { openaiTitler } from "../transcription/openai";
import type { Titler } from "../transcription/titler";
import type { Env } from "../types";
import {
  TaskDomain,
  type AddProjectAfterResult,
  type Project,
  type ProjectDefaults,
  type ProjectState,
  type Recording,
  type Task,
  type TaskParent,
  type Transcript,
  type WaitingCondition,
} from "./domain";
import type { SetTranscriptResult } from "@zero/agent-core";
import { createTitleQueue, type TitleAttempt, type TitleAttempts } from "./titles";

export const TASKDO_SQL_STORAGE_PREFIX = "taskdo_";
export const TASKDO_FIXTURE_DELETED_KEY = "fixtureDeleted";
export const TASKDO_TITLE_ATTEMPT_PREFIX = "recordingTitle:";

// The per-account todo authority. It adapts the in-process domain to Durable
// Object persistence, WebSocket synchronization, and account erasure.
export class TaskDO extends WsServerDurableObject<Env> {
  private domain!: TaskDomain;
  private persister!: ReturnType<typeof createDurableObjectSqlStoragePersister>;
  private purging = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs after TinyBase's own block has loaded the store, so voice notes
    // transcribed before titles existed, or interrupted mid-title, get one.
    void ctx.blockConcurrencyWhile(() => this.scheduleUntitled());
  }

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

  runOperation(name: string, input: unknown, today: string): Promise<OperationOutcome> {
    if (this.purging) return Promise.resolve({ ok: false, error: "Account erased" });
    return this.domain.run(name, input, today);
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

  addTask(id: string, text: string, showUpDate: string | null, parent: TaskParent | null = null,
    recurrence: Recurrence | null = null): Promise<Task | null> {
    return this.domain.addTask(id, text, showUpDate, parent, recurrence);
  }

  editTask(id: string, text: string): Promise<Task | null> {
    return this.domain.editTask(id, text);
  }

  patchTask(id: string, fields: { text?: string; showUpDate?: string | null;
    sortKey?: string; parent?: TaskParent | null }): Promise<Task | "missing-project" | null> {
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

  recording(id: string): Promise<Recording | null> {
    if (this.purging) return Promise.resolve(null);
    return this.domain.recording(id);
  }

  async setRecordingTranscript(id: string, transcript: Transcript): Promise<SetTranscriptResult> {
    if (this.purging) return "missing";
    const result = await this.domain.setRecordingTranscript(id, transcript);
    if (result === "set" && transcript.text !== "") await this.ctx.storage.setAlarm(Date.now());
    return result;
  }

  async scheduleUntitled(): Promise<void> {
    if (await this.isErased()) return;
    if (this.domain.untitledRecordings().length > 0) await this.ctx.storage.setAlarm(Date.now());
  }

  createTitler(): Titler {
    return openaiTitler({ apiKey: this.env.OPENAI_API_KEY });
  }

  // The alarm only titles voice notes. Each untitled one keeps its retry
  // state under recordingTitle:<id>, which purge's deleteAll erases.
  async alarm(): Promise<void> {
    if (await this.isErased()) return;
    const storage = this.ctx.storage;
    const attempts: TitleAttempts = {
      list: async () => {
        const stored = await storage.list<TitleAttempt>({ prefix: TASKDO_TITLE_ATTEMPT_PREFIX });
        return new Map([...stored].map(([key, value]) => [key.slice(TASKDO_TITLE_ATTEMPT_PREFIX.length), value]));
      },
      put: async (id, attempt) => {
        if (await this.isErased()) return;
        await storage.put(TASKDO_TITLE_ATTEMPT_PREFIX + id, attempt);
      },
      delete: async (id) => { await storage.delete(TASKDO_TITLE_ATTEMPT_PREFIX + id); },
    };
    const queue = createTitleQueue({
      recordings: {
        untitled: () => this.domain.untitledRecordings(),
        setTitle: (id, title) => this.domain.setRecordingTitle(id, title),
      },
      titler: this.createTitler(),
      attempts,
      report: (error, context) => reportError(this.env, error, context, { level: "error" }),
    });
    const next = await queue.runDue(Date.now());
    if (next !== null && !(await this.isErased())) await storage.setAlarm(next);
  }

  // The TinyBase synchronizer has live listeners. Stop them and close sockets
  // before deleting SQLite, or a late auto-save can recreate deleted rows.
  async purge(): Promise<void> {
    this.purging = true;
    try {
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Account erased");
      await this.persister.destroy();
      await this.ctx.storage.deleteAll();
      // deleteAll may leave a pending alarm behind.
      await this.ctx.storage.deleteAlarm();
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
