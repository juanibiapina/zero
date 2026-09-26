import { createCollection, safeRandomUUID } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import { advance, validateRecurrence, type PlainDate, type Recurrence } from "@zeroapps/recurrence";
import type { MergeableStore } from "tinybase";

import { orderKeyBetween } from "../tasks/order";
import { localToday } from "../tasks/today";
import type { Task } from "../tasks/types";
import type { Project } from "../projects/types";
import type { ProjectAttention } from "../waits/types";
import type { ProjectsApi, ProjectEditFields } from "../projects/collection";
import type { TasksApi } from "../tasks/collection";
import type { WaitsApi } from "../waits/collection";

export type TodoRecoveryRepair =
  | "make-task-loose"
  | "clear-task-recurrence"
  | "remove-after";

export type TodoRecovery = {
  table: "tasks" | "projects" | "conditions";
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
};

export type TodoApis = {
  api: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
};

export type TaskdoReplica = TodoApis & {
  store: MergeableStore;
  snapshot: () => TodoSnapshot;
  subscribe: (listener: (snapshot: TodoSnapshot) => void) => () => void;
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
};

const put = (
  store: MergeableStore,
  table: string,
  id: string,
  key: string,
  value: string | boolean | null | undefined,
) => {
  if (value == null) store.delCell(table, id, key);
  else store.setCell(table, id, key, value);
};

const requireProject = (store: MergeableStore, id: string | null): void => {
  if (id && (!store.hasRow("projects", id) || store.getCell("projects", id, "deletedAt"))) {
    throw new Error("Project was deleted or is not on this device");
  }
};

function transitionProject(
  store: MergeableStore,
  id: string,
  state: Project["state"],
  now: () => Date,
) {
  const previous = store.getCell("projects", id, "state");
  if (previous === state) return;
  put(store, "projects", id, "state", state);
  if (previous !== "done" && state !== "done") return;
  for (const [conditionId, row] of Object.entries(store.getTable("conditions"))) {
    if (row.kind !== "project-status" || row.refId !== id) continue;
    if (state === "done" && !row.resolvedAt) {
      put(store, "conditions", conditionId, "resolvedAt", now().toISOString());
      put(store, "conditions", conditionId, "settledByTarget", true);
    } else if (previous === "done" && state !== "done" && row.settledByTarget === true) {
      put(store, "conditions", conditionId, "resolvedAt", null);
      put(store, "conditions", conditionId, "settledByTarget", null);
    }
  }
}

export function repairTodoRecovery(store: MergeableStore, recovery: TodoRecovery): boolean {
  const current = projectTodoData(store).recoveries.some((issue) =>
    issue.table === recovery.table && issue.id === recovery.id &&
    issue.reason === recovery.reason && issue.repair === recovery.repair);
  if (!current || !recovery.repair) return false;
  if (recovery.repair === "make-task-loose") {
    store.delCell("tasks", recovery.id, "projectId");
  } else if (recovery.repair === "clear-task-recurrence") {
    store.delCell("tasks", recovery.id, "recurrence");
    store.delCell("tasks", recovery.id, "recurrenceDate");
  } else {
    store.delRow("conditions", recovery.id);
  }
  return true;
}

export function projectTodoData(store: MergeableStore): TodoSnapshot {
  const recoveries: TodoRecovery[] = [];
  const projectsById = new Map<string, Project>();
  for (const [id, row] of Object.entries(store.getTable("projects"))) {
    if (row.deletedAt) continue;
    if (typeof row.title !== "string" || typeof row.createdAt !== "string" ||
      (row.state !== "in-play" && row.state !== "backlog" && row.state !== "done")) {
      recoveries.push({ table: "projects", id, text: typeof row.title === "string" ? row.title : id, reason: "Invalid Project" });
      continue;
    }
    projectsById.set(id, {
      id,
      title: row.title,
      createdAt: row.createdAt,
      icon: typeof row.icon === "string" ? row.icon : "📁",
      description: typeof row.description === "string" ? row.description : null,
      state: row.state,
      sourceCaptureId: typeof row.sourceCaptureId === "string" ? row.sourceCaptureId : null,
    });
  }

  const tasks: Task[] = [];
  for (const [id, row] of Object.entries(store.getTable("tasks"))) {
    const rawProjectId = typeof row.projectId === "string" ? row.projectId : null;
    if (rawProjectId && !projectsById.has(rawProjectId)) {
      recoveries.push({
        table: "tasks",
        id,
        text: typeof row.text === "string" ? row.text : id,
        reason: store.getCell("projects", rawProjectId, "deletedAt") ? "Deleted Project" : "Missing Project",
        repair: "make-task-loose",
      });
    }
    if (typeof row.text !== "string" || typeof row.createdAt !== "string") {
      recoveries.push({ table: "tasks", id, text: typeof row.text === "string" ? row.text : id, reason: "Invalid Task" });
      continue;
    }
    let recurrence: Task["recurrence"] = null;
    if (row.recurrence !== undefined) {
      try {
        const result = typeof row.recurrence === "string"
          ? validateRecurrence(JSON.parse(row.recurrence))
          : { ok: false as const };
        if (result.ok) recurrence = result.value;
      } catch {
        // The recovery retains the raw value until the user chooses a repair.
      }
      if (!recurrence) recoveries.push({
        table: "tasks", id, text: row.text, reason: "Invalid recurrence", repair: "clear-task-recurrence",
      });
    }
    if (!row.completedAt) tasks.push({
      id,
      text: row.text,
      createdAt: row.createdAt,
      completedAt: null,
      showUpDate: typeof row.showUpDate === "string" ? row.showUpDate : null,
      recurrence,
      recurrenceDate: typeof row.recurrenceDate === "string" ? row.recurrenceDate : null,
      projectId: rawProjectId && projectsById.has(rawProjectId) ? rawProjectId : null,
      sourceCaptureId: typeof row.sourceCaptureId === "string" ? row.sourceCaptureId : null,
      sortKey: typeof row.sortKey === "string" ? row.sortKey : null,
    });
  }

  const conditions: ProjectAttention[] = [];
  const edges: { source: string; target: string }[] = [];
  const reaches = (source: string, destination: string): boolean => {
    const pending = [source];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === destination) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...edges.filter((edge) => edge.source === current).map((edge) => edge.target));
    }
    return false;
  };
  for (const [id, row] of Object.entries(store.getTable("conditions")).sort(([a], [b]) => a.localeCompare(b))) {
    const source = typeof row.projectId === "string" ? row.projectId : null;
    const target = typeof row.refId === "string" ? row.refId : null;
    const text = typeof row.text === "string" ? row.text : id;
    const conflict = (reason: string, repair?: TodoRecoveryRepair) =>
      recoveries.push({ table: "conditions", id, text, reason, ...(repair ? { repair } : {}) });
    if (!source || typeof row.createdAt !== "string" ||
      (row.resolvedAt !== undefined && typeof row.resolvedAt !== "string")) {
      conflict("Invalid condition");
      continue;
    }
    if (!projectsById.has(source)) {
      conflict("Missing source Project");
      continue;
    }
    if (row.kind === "free-text") {
      if (typeof row.text !== "string" || !row.text.trim() || target || row.targetStatus) {
        conflict("Invalid Waiting condition");
      } else if (!row.resolvedAt) {
        conditions.push({
          id, projectId: source, kind: "free-text", text: row.text, refId: null,
          targetStatus: null, resolvedAt: null, createdAt: row.createdAt,
        });
      }
      continue;
    }
    if (row.kind !== "project-status" || !target || row.targetStatus !== "done" || row.text) {
      conflict("Invalid After relationship");
      continue;
    }
    const targetProject = projectsById.get(target);
    if (!targetProject) {
      conflict("Missing target Project", "remove-after");
      continue;
    }
    if (source === target) {
      conflict("Self After relationship", "remove-after");
      continue;
    }
    if (row.resolvedAt) continue;
    if (targetProject.state === "done") {
      conflict("Target Project is Done", "remove-after");
      continue;
    }
    if (edges.some((edge) => edge.source === source && edge.target === target)) {
      conflict("Duplicate After relationship", "remove-after");
      continue;
    }
    if (reaches(target, source)) {
      conflict("Cyclic After relationship", "remove-after");
      continue;
    }
    edges.push({ source, target });
    conditions.push({
      id, projectId: source, kind: "project-status", text: null, refId: target,
      targetStatus: "done", resolvedAt: null, createdAt: row.createdAt,
    });
  }

  tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    tasks,
    projects: [...projectsById.values()].filter((project) => project.state !== "done"),
    conditions: conditions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    recoveries,
  };
}

export function createTaskdoReplica({
  store,
  queryClient,
  queryKeyScope,
  save = async () => {},
  now = () => new Date(),
  today = localToday,
  randomId = safeRandomUUID,
}: CreateTaskdoReplicaOptions): TaskdoReplica {
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
  const storeListeners = ["tasks", "projects", "conditions"].map((table) =>
    store.addTableListener(table, publish));
  const write = async (mutate: (mutableStore: MergeableStore) => void) => {
    if (closed) throw new Error("Local account is closed");
    store.transaction(() => mutate(store));
    await save();
  };

  const tasks = createCollection(queryCollectionOptions({
    queryClient,
    queryKey: keys.tasks,
    queryFn: async () => snapshot.tasks,
    getKey: (task: Task) => task.id,
    onInsert: async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const task = mutation.modified;
        await write((mutableStore) => {
          requireProject(mutableStore, task.projectId);
          if (mutableStore.hasRow("tasks", task.id)) {
            if (!mutableStore.getCell("tasks", task.id, "completedAt")) throw new Error("Task id already exists");
            mutableStore.delCell("tasks", task.id, "completedAt");
            if (task.recurrenceDate) put(mutableStore, "tasks", task.id, "recurrenceDate", task.recurrenceDate);
            put(mutableStore, "tasks", task.id, "showUpDate", task.showUpDate);
            return;
          }
          const existingKeys = Object.values(mutableStore.getTable("tasks"))
            .flatMap((row) => typeof row.sortKey === "string" ? [row.sortKey] : [])
            .sort()
            .reverse();
          let sortKey = orderKeyBetween(null, null);
          for (const key of existingKeys) {
            try {
              sortKey = orderKeyBetween(key, null);
              break;
            } catch {
              // Invalid synchronized keys stay available for explicit recovery.
            }
          }
          mutableStore.setRow("tasks", task.id, {
            text: task.text,
            createdAt: task.createdAt,
            sortKey: task.sortKey ?? sortKey,
            ...(task.showUpDate ? { showUpDate: task.showUpDate } : {}),
            ...(task.projectId ? { projectId: task.projectId } : {}),
            ...(task.sourceCaptureId ? { sourceCaptureId: task.sourceCaptureId } : {}),
            ...(task.recurrence ? { recurrence: JSON.stringify(task.recurrence) } : {}),
            ...(task.recurrenceDate ? { recurrenceDate: task.recurrenceDate } : {}),
          });
        });
      }
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write((mutableStore) => {
        const id = mutation.modified.id;
        if (!mutableStore.hasRow("tasks", id)) throw new Error("Task not found");
        if (("completedAt" in mutation.changes || "recurrenceDate" in mutation.changes) &&
          projectTodoData(mutableStore).recoveries.some((issue) => issue.table === "tasks" && issue.id === id &&
            issue.reason === "Invalid recurrence")) {
          throw new Error("Recover the invalid recurrence before completing this Task");
        }
        if ("projectId" in mutation.changes) requireProject(mutableStore, mutation.modified.projectId);
        for (const key of Object.keys(mutation.changes) as (keyof Task)[]) {
          if (key === "id" || key === "createdAt") continue;
          const value = mutation.modified[key];
          if (key === "recurrence") put(mutableStore, "tasks", id, key, value ? JSON.stringify(value) : null);
          else put(mutableStore, "tasks", id, key, value as string | null | undefined);
        }
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
      for (const mutation of transaction.mutations) await write((mutableStore) => {
        const project = mutation.modified;
        if (mutableStore.hasRow("projects", project.id)) {
          requireProject(mutableStore, project.id);
          if (mutableStore.getCell("projects", project.id, "state") !== "done") throw new Error("Project id already exists");
          transitionProject(mutableStore, project.id, project.state, now);
          return;
        }
        mutableStore.setRow("projects", project.id, {
          title: project.title,
          icon: project.icon,
          state: project.state,
          createdAt: project.createdAt,
          ...(project.description ? { description: project.description } : {}),
          ...(project.sourceCaptureId ? { sourceCaptureId: project.sourceCaptureId } : {}),
        });
      });
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write((mutableStore) => {
        const id = mutation.modified.id;
        requireProject(mutableStore, id);
        for (const key of Object.keys(mutation.changes) as (keyof Project)[]) {
          if (key === "id" || key === "createdAt" || key === "state") continue;
          put(mutableStore, "projects", id, key, mutation.modified[key]);
        }
        if ("state" in mutation.changes) transitionProject(mutableStore, id, mutation.modified.state, now);
      });
      return { refetch: false };
    },
    onDelete: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write((mutableStore) => {
        const id = mutation.original.id;
        requireProject(mutableStore, id);
        put(mutableStore, "projects", id, "deletedAt", now().toISOString());
        for (const [taskId, row] of Object.entries(mutableStore.getTable("tasks"))) {
          if (row.projectId === id) mutableStore.delRow("tasks", taskId);
        }
        for (const [conditionId, row] of Object.entries(mutableStore.getTable("conditions"))) {
          if (row.projectId === id || row.refId === id) mutableStore.delRow("conditions", conditionId);
        }
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
      for (const mutation of transaction.mutations) await write((mutableStore) => {
        const condition = mutation.modified;
        requireProject(mutableStore, condition.projectId);
        if (mutableStore.hasRow("conditions", condition.id)) throw new Error("Condition id already exists");
        if (condition.kind === "project-status") {
          requireProject(mutableStore, condition.refId);
          if (condition.projectId === condition.refId) throw new Error("A Project cannot be after itself");
          if (mutableStore.getCell("projects", condition.refId, "state") === "done") throw new Error("Target Project is Done");
          const openAfters = projectTodoData(mutableStore).conditions.filter((row) => row.kind === "project-status");
          if (openAfters.some((edge) => edge.projectId === condition.projectId && edge.refId === condition.refId)) {
            throw new Error("After relationship already exists");
          }
          const pending = [condition.refId];
          const seen = new Set<string>();
          while (pending.length) {
            const id = pending.pop()!;
            if (id === condition.projectId) throw new Error("After relationship would create a cycle");
            if (seen.has(id)) continue;
            seen.add(id);
            pending.push(...openAfters.filter((edge) => edge.projectId === id).map((edge) => edge.refId));
          }
        }
        mutableStore.setRow("conditions", condition.id, {
          projectId: condition.projectId,
          kind: condition.kind,
          createdAt: condition.createdAt,
          ...(condition.kind === "free-text"
            ? { text: condition.text }
            : { refId: condition.refId, targetStatus: "done" }),
        });
      });
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write((mutableStore) => {
        if (!mutableStore.hasRow("conditions", mutation.modified.id)) throw new Error("Condition not found");
        put(mutableStore, "conditions", mutation.modified.id, "resolvedAt", mutation.modified.resolvedAt);
      });
      return { refetch: false };
    },
    onDelete: async ({ transaction }) => {
      for (const mutation of transaction.mutations) await write((mutableStore) => {
        mutableStore.delRow("conditions", mutation.original.id);
      });
      return { refetch: false };
    },
  }));

  const noError = () => null;
  const noErrorSubscription = () => () => {};
  const noRefetch = async () => {};
  const api: TasksApi = {
    collection: tasks,
    add: (text, showUpDate = null, projectId = null, sourceCaptureId = null, recurrence = null) => tasks.insert({
      id: randomId(), text, createdAt: now().toISOString(), showUpDate: recurrence?.origin ?? showUpDate,
      projectId, sourceCaptureId, recurrence, recurrenceDate: recurrence?.origin ?? null,
      completedAt: null, sortKey: null,
    }),
    edit: (id, text) => tasks.update(id, (draft) => { draft.text = text; }),
    complete: (id, completedOn = today()) => tasks.update(id, (draft) => {
      if (draft.recurrence && draft.recurrenceDate) {
        const next = advance(draft.recurrence, { scheduledOn: draft.recurrenceDate, completedOn });
        if (next.kind === "next") {
          draft.recurrenceDate = next.scheduledOn;
          draft.showUpDate = next.scheduledOn;
          return;
        }
      }
      draft.completedAt = now().toISOString();
    }),
    completeForever: (id) => tasks.update(id, (draft) => { draft.completedAt = now().toISOString(); }),
    undoOccurrence: (before) => tasks.get(before.id)
      ? tasks.update(before.id, (draft) => { Object.assign(draft, before, { completedAt: null }); })
      : tasks.insert({ ...before, completedAt: null }),
    setRecurrence: (id, recurrence: Recurrence | null) => tasks.update(id, (draft) => {
      draft.recurrence = recurrence;
      draft.recurrenceDate = recurrence?.origin ?? null;
      if (recurrence) draft.showUpDate = recurrence.origin;
    }),
    reopen: (task) => tasks.get(task.id)
      ? tasks.update(task.id, (draft) => { draft.completedAt = null; })
      : tasks.insert({ ...task, completedAt: null }),
    reschedule: (id, date) => tasks.update(id, (draft) => { draft.showUpDate = date; }),
    reorder: (id, sortKey) => tasks.update(id, (draft) => { draft.sortKey = sortKey; }),
    moveToProject: (id, projectId) => tasks.update(id, (draft) => { draft.projectId = projectId; }),
    offline: true,
    refetch: noRefetch,
    getLoadError: noError,
    subscribeLoadError: noErrorSubscription,
  };
  const projectsApi: ProjectsApi = {
    collection: projects,
    add: (title, sourceCaptureId = null) => projects.insert({
      id: randomId(), title, icon: "📁", description: null, state: "in-play",
      createdAt: now().toISOString(), sourceCaptureId,
    }),
    edit: (id, fields: ProjectEditFields) => projects.update(id, (draft) => { Object.assign(draft, fields); }),
    setState: (id, state) => projects.update(id, (draft) => { draft.state = state; }),
    reopen: (project) => projects.get(project.id)
      ? projects.update(project.id, (draft) => { draft.state = project.state; })
      : projects.insert({ ...project }),
    remove: (id) => projects.delete(id),
    offline: true,
    refetch: noRefetch,
    getLoadError: noError,
    subscribeLoadError: noErrorSubscription,
  };
  const waitsApi: WaitsApi = {
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
    offline: true,
    refetch: noRefetch,
    getLoadError: noError,
    subscribeLoadError: noErrorSubscription,
  };

  return {
    store,
    api,
    projectsApi,
    waitsApi,
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    async repair(recovery) {
      let changed = false;
      await write((mutableStore) => {
        changed = repairTodoRecovery(mutableStore, recovery);
      });
      return changed;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const listenerId of storeListeners) store.delListener(listenerId);
      listeners.clear();
      await Promise.all([tasks.cleanup(), projects.cleanup(), waits.cleanup()]);
    },
  };
}
