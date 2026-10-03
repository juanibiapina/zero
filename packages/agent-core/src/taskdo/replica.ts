import { createCollection, safeRandomUUID, type Collection, type Transaction } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import type { PlainDate, Recurrence, Schedule } from "@zeroapps/recurrence";
import type { MergeableStore } from "tinybase";

import type { Project, ProjectState } from "../projects/types";
import { localToday } from "../tasks/today";
import type { ProjectAttention, Task } from "./types";
import { TodoModel, type TodoIssue } from "./model";
import { MedicineModel, type MedicineInput, type Medicine, type Dose, type MedicineReceipt } from "../medicines/model";

export type TodoRecoveryRepair =
  | "make-task-loose"
  | "clear-task-recurrence"
  | "remove-after";

export type TodoRecovery = {
  table: "tasks" | "projects" | "conditions" | "medicines" | "doses";
  id: string;
  text: string;
  reason: string;
  repair?: TodoRecoveryRepair;
};

export type TodoSnapshot = {
  tasks: Task[];
  projects: Project[];
  conditions: ProjectAttention[];
  recoveries: TodoRecovery[];
  medicines: Medicine[];
  doses: Dose[];
};

export type ProjectEditFields = {
  title?: string;
  icon?: string;
  description?: string | null;
};

export type TodoTasks = {
  collection: Collection<Task, string>;
  add: (
    text: string,
    showUpDate?: string | null,
    projectId?: string | null,
    recurrence?: Recurrence | null,
  ) => Transaction;
  complete: (id: string, completedOn?: PlainDate) => Transaction;
  completeForever: (id: string) => Transaction;
  undoOccurrence: (taskBefore: Task, completedOn: PlainDate) => Transaction;
  setRecurrence: (id: string, recurrence: Recurrence | null) => Transaction;
  reopen: (task: Task) => Transaction;
  edit: (id: string, text: string, schedule?: Schedule) => Transaction;
  reschedule: (id: string, showUpDate: string | null) => Transaction;
  reorder: (id: string, sortKey: string) => Transaction;
  moveToProject: (id: string, projectId: string | null) => Transaction;
};

export type TodoProjects = {
  collection: Collection<Project, string>;
  add: (title: string) => Transaction;
  setState: (id: string, state: ProjectState) => Transaction;
  reopen: (project: Project) => Transaction;
  edit: (id: string, fields: ProjectEditFields) => Transaction;
  remove: (id: string) => Transaction;
};

export type TodoWaits = {
  collection: Collection<ProjectAttention, string>;
  addWaiting: (projectId: string, text: string) => Transaction;
  addAfter: (projectId: string, afterProjectId: string) => Transaction;
  resolveWaiting: (id: string) => Transaction;
  remove: (id: string) => Transaction;
};

export type TodoMedicines = {
  add: (input: MedicineInput, creationId?: string) => Promise<Medicine>;
  edit: (id: string, input: MedicineInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  take: (dose: Dose) => Promise<void>;
  undo: (id: string) => Promise<void>;
  applyReceipts: (receipts: MedicineReceipt[], deviceId: string) => Promise<void>;
};

export type TaskdoReplica = {
  store: MergeableStore;
  tasks: TodoTasks;
  projects: TodoProjects;
  waits: TodoWaits;
  medicines: TodoMedicines;
  snapshot: () => TodoSnapshot;
  subscribe: (listener: (snapshot: TodoSnapshot) => void) => () => void;
  refresh: () => Promise<void>;
  saveLocal: () => Promise<void>;
  repair: (recovery: TodoRecovery) => Promise<boolean>;
  close: () => Promise<void>;
};

type Clock = {
  now?: () => Date;
  today?: () => PlainDate;
  randomId?: () => string;
};

export type CreateTaskdoReplicaOptions = Clock & {
  store: MergeableStore;
  queryClient: QueryClient;
  queryKeyScope: readonly unknown[];
  save?: () => Promise<unknown>;
  refresh?: () => Promise<void>;
};

function recoveryFor(store: MergeableStore, issue: TodoIssue): TodoRecovery {
  const row = store.getRow(issue.table, issue.id);
  const text = typeof row.text === "string"
    ? row.text
    : issue.table === "projects" && typeof row.title === "string" ? row.title : issue.id;
  if (issue.table === "projects") return { table: "projects", id: issue.id, text, reason: "Invalid Project" };
  if (issue.table === "tasks") {
    const detail = {
      "invalid-task": { reason: "Invalid Task" },
      "invalid-recurrence": { reason: "Invalid recurrence", repair: "clear-task-recurrence" as const },
      "missing-project": { reason: "Missing Project", repair: "make-task-loose" as const },
      "deleted-project": { reason: "Deleted Project", repair: "make-task-loose" as const },
    }[issue.reason];
    return { table: "tasks", id: issue.id, text, ...detail };
  }
  const detail = {
    "invalid-condition": { reason: "Invalid condition" },
    "invalid-waiting": { reason: "Invalid Waiting condition" },
    "invalid-after": { reason: "Invalid After relationship" },
    "missing-source": { reason: "Missing source Project" },
    "missing-target": { reason: "Missing target Project", repair: "remove-after" as const },
    "target-done": { reason: "Target Project is Done", repair: "remove-after" as const },
    self: { reason: "Self After relationship", repair: "remove-after" as const },
    duplicate: { reason: "Duplicate After relationship", repair: "remove-after" as const },
    cycle: { reason: "Cyclic After relationship", repair: "remove-after" as const },
  }[issue.reason];
  return { table: "conditions", id: issue.id, text, ...detail };
}

export function projectTodoData(store: MergeableStore): TodoSnapshot {
  const projection = new TodoModel({ store }).project({ taskOrder: "created" });
  const medicineSnapshot = new MedicineModel(store).snapshot();
  return {
    tasks: projection.tasks,
    projects: projection.projects,
    conditions: projection.conditions,
    recoveries: [...projection.issues.map((issue) => recoveryFor(store, issue)), ...medicineSnapshot.recoveries],
    medicines: medicineSnapshot.medicines,
    doses: medicineSnapshot.doses,
  };
}

export function repairTodoRecovery(store: MergeableStore, recovery: TodoRecovery): boolean {
  const model = new TodoModel({ store });
  const issue = model.project().issues.find((candidate) => {
    const current = recoveryFor(store, candidate);
    return current.table === recovery.table && current.id === recovery.id &&
      current.reason === recovery.reason && current.repair === recovery.repair;
  });
  return issue ? model.repair(issue) : false;
}

function taskError(conflict: string): never {
  if (conflict === "missing-project") throw new Error("Project was deleted or is not on this device");
  if (conflict === "invalid-recurrence") throw new Error("Recover the invalid recurrence before completing this Task");
  if (conflict === "missing-task") throw new Error("Task not found");
  throw new Error("Task id already exists");
}

function projectError(conflict: string): never {
  if (conflict === "id-conflict") throw new Error("Project id already exists");
  throw new Error("Project was deleted or is not on this device");
}

function conditionError(conflict: string): never {
  const message: Record<string, string> = {
    "id-conflict": "Condition id already exists",
    "missing-project": "Project was deleted or is not on this device",
    "missing-source": "Project was deleted or is not on this device",
    "missing-target": "Project was deleted or is not on this device",
    "target-done": "Target Project is Done",
    self: "A Project cannot be after itself",
    duplicate: "After relationship already exists",
    cycle: "After relationship would create a cycle",
    "missing-condition": "Condition not found",
  };
  throw new Error(message[conflict] ?? conflict);
}

export function createTaskdoReplica({
  store,
  queryClient,
  queryKeyScope,
  save = async () => {},
  refresh = async () => {},
  now = () => new Date(),
  today = localToday,
  randomId = safeRandomUUID,
}: CreateTaskdoReplicaOptions): TaskdoReplica {
  const model = new TodoModel({ store, now });
  const medicineModel = new MedicineModel(store, now);
  const keys = {
    tasks: ["taskdo", ...queryKeyScope, "tasks"],
    projects: ["taskdo", ...queryKeyScope, "projects"],
    conditions: ["taskdo", ...queryKeyScope, "conditions"],
  };
  const listeners = new Set<(snapshot: TodoSnapshot) => void>();
  let closed = false;
  let snapshot = projectTodoData(store);
  const publish = () => {
    snapshot = projectTodoData(store);
    queryClient.setQueryData(keys.tasks, snapshot.tasks);
    queryClient.setQueryData(keys.projects, snapshot.projects);
    queryClient.setQueryData(keys.conditions, snapshot.conditions);
    for (const listener of listeners) listener(snapshot);
  };
  publish();
  const storeListeners = ["tasks", "projects", "conditions", "medicines", "doses"].map((table) => store.addTableListener(table, publish));
  const write = async (mutate: () => void) => {
    if (closed) throw new Error("Local account is closed");
    store.transaction(mutate);
    await save();
  };

  const tasks = createCollection(queryCollectionOptions({
    queryClient,
    queryKey: keys.tasks,
    queryFn: async () => snapshot.tasks,
    getKey: (task: Task) => task.id,
    onInsert: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write(() => {
        const task = mutation.modified;
        const result = store.hasRow("tasks", task.id) ? model.restoreTask(task) : model.createTask(task);
        if (!result.ok) taskError(result.conflict);
      });
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write(() => {
        const fields: Partial<Omit<Task, "id" | "createdAt">> = {};
        for (const key of Object.keys(mutation.changes) as (keyof Task)[]) {
          if (key !== "id" && key !== "createdAt") Object.assign(fields, { [key]: mutation.modified[key] });
        }
        const result = model.updateTask(mutation.modified.id, fields);
        if (!result.ok) taskError(result.conflict);
      });
      return { refetch: false };
    },
  }));

  const projects = createCollection(queryCollectionOptions({
    queryClient,
    queryKey: keys.projects,
    queryFn: async () => snapshot.projects,
    getKey: (project: Project) => project.id,
    onInsert: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write(() => {
        const project = mutation.modified;
        const result = store.hasRow("projects", project.id)
          ? model.restoreProject(project)
          : model.createProject(project);
        if (!result.ok) projectError(result.conflict);
      });
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write(() => {
        const { id } = mutation.modified;
        const fields: ProjectEditFields = {};
        if ("title" in mutation.changes) fields.title = mutation.modified.title;
        if ("icon" in mutation.changes) fields.icon = mutation.modified.icon;
        if ("description" in mutation.changes) fields.description = mutation.modified.description;
        if (Object.keys(fields).length) {
          const result = model.editProject(id, fields);
          if (!result.ok) projectError(result.conflict);
        }
        if ("state" in mutation.changes) {
          const result = model.setProjectState(id, mutation.modified.state);
          if (!result.ok) projectError(result.conflict);
        }
      });
      return { refetch: false };
    },
    onDelete: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write(() => {
        if (!model.getProject(mutation.original.id)) projectError("missing-project");
        model.deleteProject(mutation.original.id);
      });
      return { refetch: false };
    },
  }));

  const waits = createCollection(queryCollectionOptions({
    queryClient,
    queryKey: keys.conditions,
    queryFn: async () => snapshot.conditions,
    getKey: (condition: ProjectAttention) => condition.id,
    onInsert: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write(() => {
        const condition = mutation.modified;
        const result = condition.kind === "free-text"
          ? model.createWaiting(condition.id, condition.projectId, condition.text, condition.createdAt)
          : model.createAfter(condition.id, condition.projectId, condition.refId, condition.createdAt);
        if (!result.ok) conditionError(result.conflict);
      });
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write(() => {
        const result = model.setConditionResolvedAt(mutation.modified.id, mutation.modified.resolvedAt);
        if (!result.ok) conditionError(result.conflict);
      });
      return { refetch: false };
    },
    onDelete: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write(() => { model.deleteCondition(mutation.original.id); });
      return { refetch: false };
    },
  }));

  const taskActions: TodoTasks = {
    collection: tasks,
    add: (text, showUpDate = null, projectId = null, recurrence = null) => tasks.insert({
      id: randomId(), text, createdAt: now().toISOString(), showUpDate: recurrence?.origin ?? showUpDate,
      projectId, recurrence, recurrenceDate: recurrence?.origin ?? null,
      completedAt: null, sortKey: null,
    }),
    edit: (id, text, schedule) => tasks.update(id, (draft) => {
      draft.text = text;
      if (schedule?.kind === "once") draft.showUpDate = schedule.date;
      if (schedule?.kind === "recurring") Object.assign(draft, model.planTaskRecurrence(schedule.recurrence));
    }),
    complete: (id, completedOn = today()) => tasks.update(id, (draft) => {
      Object.assign(draft, model.planTaskCompletion(draft, completedOn));
    }),
    completeForever: (id) => tasks.update(id, (draft) => {
      draft.completedAt = model.planTaskCompletion({ ...draft, recurrence: null }, today()).completedAt!;
    }),
    undoOccurrence: (before) => tasks.get(before.id)
      ? tasks.update(before.id, (draft) => { Object.assign(draft, before, { completedAt: null }); })
      : tasks.insert({ ...before, completedAt: null }),
    setRecurrence: (id, recurrence: Recurrence | null) => tasks.update(id, (draft) => {
      Object.assign(draft, model.planTaskRecurrence(recurrence));
    }),
    reopen: (task) => tasks.get(task.id)
      ? tasks.update(task.id, (draft) => { draft.completedAt = null; })
      : tasks.insert({ ...task, completedAt: null }),
    reschedule: (id, date) => tasks.update(id, (draft) => { draft.showUpDate = date; }),
    reorder: (id, sortKey) => tasks.update(id, (draft) => { draft.sortKey = sortKey; }),
    moveToProject: (id, projectId) => tasks.update(id, (draft) => { draft.projectId = projectId; }),
  };
  const projectActions: TodoProjects = {
    collection: projects,
    add: (title) => projects.insert({
      id: randomId(), title, icon: "📁", description: null, state: "in-play",
      createdAt: now().toISOString(),
    }),
    edit: (id, fields: ProjectEditFields) => projects.update(id, (draft) => { Object.assign(draft, fields); }),
    setState: (id, state) => projects.update(id, (draft) => { draft.state = state; }),
    reopen: (project) => projects.get(project.id)
      ? projects.update(project.id, (draft) => { draft.state = project.state; })
      : projects.insert({ ...project }),
    remove: (id) => projects.delete(id),
  };
  const waitActions: TodoWaits = {
    collection: waits,
    addWaiting: (projectId, text) => waits.insert({
      id: randomId(), projectId, kind: "free-text", text, refId: null,
      targetStatus: null, resolvedAt: null, createdAt: now().toISOString(),
    }),
    addAfter: (projectId, refId) => waits.insert({
      id: randomId(), projectId, kind: "project-status", text: null, refId,
      targetStatus: "done", resolvedAt: null, createdAt: now().toISOString(),
    }),
    resolveWaiting: (id) => waits.update(id, (draft) => { draft.resolvedAt = now().toISOString(); }),
    remove: (id) => waits.delete(id),
  };

  return {
    store,
    tasks: taskActions,
    projects: projectActions,
    waits: waitActions,
    medicines: {
      async add(input, creationId = randomId()) {
        let result!: Medicine;
        await write(() => {
          if (medicineModel.get(creationId)) {
            medicineModel.edit(creationId, input);
            result = medicineModel.get(creationId)!;
          } else result = medicineModel.add(creationId, input);
        });
        return result;
      },
      edit: (id, input) => write(() => { medicineModel.edit(id, input); }),
      remove: (id) => write(() => { medicineModel.remove(id); }),
      take: (dose) => write(() => { medicineModel.take(dose, randomId()); }),
      undo: (id) => write(() => { medicineModel.undo(id, randomId()); }),
      applyReceipts: (receipts, deviceId) => write(() => { medicineModel.applyReceipts(receipts, deviceId); }),
    },
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    async repair(recovery) {
      let changed = false;
      await write(() => { changed = repairTodoRecovery(store, recovery); });
      return changed;
    },
    refresh,
    saveLocal: () => write(() => {}),
    async close() {
      if (closed) return;
      closed = true;
      for (const listenerId of storeListeners) store.delListener(listenerId);
      listeners.clear();
      await Promise.all([tasks.cleanup(), projects.cleanup(), waits.cleanup()]);
    },
  };
}
