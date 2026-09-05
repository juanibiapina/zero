import type { Collection, Transaction } from "@tanstack/db";
import type { QueryClient } from "@tanstack/react-query";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";

import {
  createEntityApi,
  createInMemoryEntityApi,
  createPersistedEntityApi,
  entityQueryKey,
  verbsFor,
  type EntityApi,
  type EntityApiDeps,
  type EntitySpec,
  type StartOfflineExecutor,
  type WarnFn,
} from "../collection/base";
import type { Task } from "./types";

// The Task data layer (Today list): the Task verbs (add, complete) over the
// shared collection factory in ../collection/base. Everything about offline
// persistence, reconcile and readiness lives there; this file holds only what
// is Task-specific.

// The REST calls the collection needs, already auth-bound by the caller. Web
// injects same-origin cookie closures (no token); mobile injects closures that
// carry the Clerk Bearer token.
export type TasksRest = {
  fetchTasks: () => Promise<Task[]>;
  // The client mints the task's id (a stable UUID) and its showUpDate (the local
  // day), so the optimistic row and the server's row share one key and the
  // server dedupes on the id: a retried add (offline outbox replay) re-sends the
  // same id and gets the stored row back, not a second task.
  addTask: (task: {
    id: string;
    text: string;
    showUpDate: string;
    projectId: string | null;
    takenOnAt: string | null;
  }) => Promise<Task>;
  completeTask: (id: string) => Promise<Task>;
  // Take a task on (a timestamp) or park it (null). Idempotent on the id.
  setTaskTakenOn: (id: string, takenOnAt: string | null) => Promise<Task>;
};

// One handle over the Today data layer. Both Today screens read `collection`
// through a live query (filtering showUpDate <= local today) and write with
// `add` / `complete`, which return the underlying transaction so the page can
// surface a write error via `tx.isPersisted.promise`.
export type TasksApi = {
  collection: Collection<Task, string>;
  // `showUpDate` is the caller's local today (YYYY-MM-DD); v1 always dates a new
  // task today, but the field is explicit so a future reschedule can pass another
  // day without changing this seam. `projectId` is the Project the task belongs
  // to, or null/omitted for a loose task (the Home quick-add).
  add: (
    text: string,
    showUpDate: string,
    projectId?: string | null,
    takenOnAt?: string | null,
  ) => Transaction;
  complete: (id: string) => Transaction;
  // Curation: take a task on (surface it on Home) or park it. `takeOn` stamps a
  // timestamp now; `park` clears it.
  takeOn: (id: string) => Transaction;
  park: (id: string) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

// The react-query key the in-memory collection reads through. Distinct from the
// Capture and Project keys so the collections never share a cache entry.
export const TASKS_QUERY_KEY = entityQueryKey("tasks");

// The verb table. Each key is the outbox mutationFn name (durable: a queued
// offline write replays by it), so the keys never change.
export function tasksSpec(rest: TasksRest) {
  const v = verbsFor<Task>();
  const verbs = {
    addTask: v.insert<{
      text: string;
      showUpDate: string;
      projectId: string | null;
      takenOnAt: string | null;
    }>({
      row: ({ text, showUpDate, projectId, takenOnAt }) => ({
        text,
        showUpDate,
        projectId,
        takenOnAt,
        completedAt: null,
      }),
      persist: (row) =>
        rest.addTask({
          id: row.id,
          text: row.text,
          showUpDate: row.showUpDate,
          projectId: row.projectId,
          takenOnAt: row.takenOnAt,
        }),
    }),
    completeTask: v.update<{ id: string }>({
      id: ({ id }) => id,
      draft: () => (draft) => {
        draft.completedAt = new Date().toISOString();
      },
      matches: ({ modified }) => modified.completedAt != null,
      persist: (id) => rest.completeTask(id),
    }),
    setTakenOn: v.update<{ id: string; takenOnAt: string | null }>({
      id: ({ id }) => id,
      draft:
        ({ takenOnAt }) =>
        (draft) => {
          draft.takenOnAt = takenOnAt;
        },
      matches: () => true,
      persist: (id, { modified }) => rest.setTaskTakenOn(id, modified.takenOnAt),
    }),
  };
  const spec: EntitySpec<Task, typeof verbs> = {
    name: "tasks",
    fetch: () => rest.fetchTasks(),
    verbs,
  };
  return spec;
}

function toTasksApi(
  api: EntityApi<Task, ReturnType<typeof tasksSpec>["verbs"]>,
): TasksApi {
  return {
    collection: api.collection,
    add: (text, showUpDate, projectId = null, takenOnAt = null) =>
      api.actions.addTask({ text, showUpDate, projectId, takenOnAt }),
    complete: (id) => api.actions.completeTask({ id }),
    takeOn: (id) =>
      api.actions.setTakenOn({ id, takenOnAt: new Date().toISOString() }),
    park: (id) => api.actions.setTakenOn({ id, takenOnAt: null }),
    offline: api.offline,
    refetch: api.refetch,
    getLoadError: api.getLoadError,
    subscribeLoadError: api.subscribeLoadError,
  };
}

// In-memory fallback (no durable offline writes); see the shared factory.
export function createInMemoryTasksApi(deps: {
  queryClient: QueryClient;
  rest: TasksRest;
}): TasksApi {
  return toTasksApi(
    createInMemoryEntityApi({
      spec: tasksSpec(deps.rest),
      queryClient: deps.queryClient,
    }),
  );
}

// Durable offline mode; see the shared factory.
export function createPersistedTasksApi(deps: {
  rest: TasksRest;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): TasksApi {
  return toTasksApi(
    createPersistedEntityApi({
      spec: tasksSpec(deps.rest),
      persistence: deps.persistence,
      startOfflineExecutor: deps.startOfflineExecutor,
      onWarn: deps.onWarn,
    }),
  );
}

// Build the Task data layer: durable offline persistence when it can start,
// else the in-memory fallback.
export async function createTasksApi(
  deps: EntityApiDeps & { rest: TasksRest },
): Promise<TasksApi> {
  const { rest, ...base } = deps;
  return toTasksApi(await createEntityApi({ spec: tasksSpec(rest), ...base }));
}
