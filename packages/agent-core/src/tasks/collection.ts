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
    showUpDate: string | null;
    projectId: string | null;
    sourceCaptureId: string | null;
  }) => Promise<Task>;
  completeTask: (id: string) => Promise<Task>;
  // The inverse of complete: clear completedAt so the task returns to the open
  // list. Backs the Home task-complete Undo. Idempotent on the id.
  reopenTask: (id: string) => Promise<Task>;
  // Replace a task's text (title edit). Idempotent on the id.
  editTask: (id: string, text: string) => Promise<Task>;
  // Set (or clear, with null) a task's show-up date. Idempotent on the id.
  rescheduleTask: (id: string, showUpDate: string | null) => Promise<Task>;
  // Set a task's manual sort key (drag-reorder). Idempotent on the id.
  reorderTask: (id: string, sortKey: string) => Promise<Task>;
  // Move a task into a project (a uuid) or back to loose (null). Idempotent on
  // the id.
  setTaskProject: (id: string, projectId: string | null) => Promise<Task>;
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
    showUpDate?: string | null,
    projectId?: string | null,
    sourceCaptureId?: string | null,
  ) => Transaction;
  complete: (id: string) => Transaction;
  // Reverse a completion (Undo on the complete snackbar): the task returns to the
  // open list. Takes the whole task, not just its id, because completing it
  // reconciles the row out of the collection (the server list is open-only), so
  // Undo must be able to re-insert it — see the `revive` verb.
  reopen: (task: Task) => Transaction;
  // Replace a task's text optimistically (title edit).
  edit: (id: string, text: string) => Transaction;
  // Set (or clear, with null) a task's show-up date optimistically. Postpone is
  // reschedule(id, tomorrow); the optimistic move drops the row from Home at
  // once (the shown-up gate) and lands it in Upcoming.
  reschedule: (id: string, showUpDate: string | null) => Transaction;
  // Set a task's manual sort key optimistically (drag-reorder). The caller mints
  // the key between the drop position's neighbors with orderKeyBetween.
  reorder: (id: string, sortKey: string) => Transaction;
  // Move a task into a project (a uuid) or back to loose (null), optimistically.
  moveToProject: (id: string, projectId: string | null) => Transaction;
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
// One collection.update backs reorder, reschedule, complete, move-to-project
// and the text edit; the in-memory path tells them apart by the changed field
// set, in this order: sortKey changed → reorder; showUpDate changed →
// reschedule; completedAt set → complete; projectId changed → move-to-project;
// else → edit (the catch-all). reopen is a revive (routed by metadata,
// not by matches).
export function tasksSpec(rest: TasksRest) {
  const v = verbsFor<Task>();
  const verbs = {
    addTask: v.insert<{
      text: string;
      showUpDate: string | null;
      projectId: string | null;
      sourceCaptureId: string | null;
    }>({
      row: ({ text, showUpDate, projectId, sourceCaptureId }) => ({
        text,
        showUpDate,
        projectId,
        sourceCaptureId,
        completedAt: null,
        // Null sorts last, so a new task lands at the bottom of the manual order
        // (newest-at-bottom). The server mints the real trailing key on
        // reconcile, still at the bottom — no jump. So the client never mints a
        // key on add.
        sortKey: null,
      }),
      persist: (row) =>
        rest.addTask({
          id: row.id,
          text: row.text,
          showUpDate: row.showUpDate,
          projectId: row.projectId,
          sourceCaptureId: row.sourceCaptureId ?? null,
        }),
    }),
    reorderTask: v.update<{ id: string; sortKey: string }>({
      id: ({ id }) => id,
      draft:
        ({ sortKey }) =>
        (draft) => {
          draft.sortKey = sortKey;
        },
      matches: ({ changes }) => "sortKey" in changes,
      persist: (id, { modified }) => rest.reorderTask(id, modified.sortKey!),
    }),
    rescheduleTask: v.update<{ id: string; showUpDate: string | null }>({
      id: ({ id }) => id,
      draft:
        ({ showUpDate }) =>
        (draft) => {
          draft.showUpDate = showUpDate;
        },
      matches: ({ changes }) => "showUpDate" in changes,
      persist: (id, { modified }) =>
        rest.rescheduleTask(id, modified.showUpDate),
    }),
    completeTask: v.update<{ id: string }>({
      id: ({ id }) => id,
      draft: () => (draft) => {
        draft.completedAt = new Date().toISOString();
      },
      matches: ({ modified }) => modified.completedAt != null,
      persist: (id) => rest.completeTask(id),
    }),
    // A revive, not an update: completing the task reconciles it out of the
    // collection (the server list is open-only), so Undo must re-insert the row
    // when it is absent (and update it in place when Undo is tapped before the
    // eviction lands). It carries the whole task so it can re-insert.
    reopenTask: v.revive<Task>({
      id: (task) => task.id,
      row: (task) => ({ ...task, completedAt: null }),
      draft: () => (draft) => {
        draft.completedAt = null;
      },
      persist: (id) => rest.reopenTask(id),
    }),
    // Move into a project (or back to loose). Matches on `"projectId" in changes`.
    moveToProject: v.update<{ id: string; projectId: string | null }>({
      id: ({ id }) => id,
      draft:
        ({ projectId }) =>
        (draft) => {
          draft.projectId = projectId;
        },
      matches: ({ changes }) => "projectId" in changes,
      persist: (id, { modified }) =>
        rest.setTaskProject(id, modified.projectId),
    }),
    // Catch-all: an update that changed none of the above is a text edit.
    editTask: v.update<{ id: string; text: string }>({
      id: ({ id }) => id,
      draft:
        ({ text }) =>
        (draft) => {
          draft.text = text;
        },
      matches: () => true,
      persist: (id, { modified }) => rest.editTask(id, modified.text),
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
    add: (text, showUpDate = null, projectId = null, sourceCaptureId = null) =>
      api.actions.addTask({ text, showUpDate, projectId, sourceCaptureId }),
    complete: (id) => api.actions.completeTask({ id }),
    reopen: (task) => api.actions.reopenTask(task),
    edit: (id, text) => api.actions.editTask({ id, text }),
    reschedule: (id, showUpDate) =>
      api.actions.rescheduleTask({ id, showUpDate }),
    reorder: (id, sortKey) => api.actions.reorderTask({ id, sortKey }),
    moveToProject: (id, projectId) =>
      api.actions.moveToProject({ id, projectId }),
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
