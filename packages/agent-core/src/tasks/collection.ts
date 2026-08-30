import {
  createCollection,
  safeRandomUUID,
  type Collection,
  type SyncConfig,
  type Transaction,
} from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";

// StartOfflineExecutor and WarnFn are generic offline/logging infra shared with
// the Capture data layer (not domain-specific), so the Task layer reuses them
// instead of re-declaring them. The domain logic below is a deliberate sibling
// of captures/collection.ts; extract a shared base at the ~3rd entity, per
// docs/todo-app.md (Rule of Three).
import type { StartOfflineExecutor, WarnFn } from "../captures/collection";
import type { Task } from "./types";

// The three REST calls the collection needs, already auth-bound by the caller.
// Web injects same-origin cookie closures (no token); mobile injects closures
// that carry the Clerk Bearer token.
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
  }) => Promise<Task>;
  completeTask: (id: string) => Promise<Task>;
};

// One handle over the Today data layer. Both Today screens read `collection`
// through a live query (filtering showUpDate <= local today) and write with
// `add` / `complete`, which return the underlying transaction so the page can
// surface a write error via `tx.isPersisted.promise`.
export type TasksApi = {
  collection: Collection<Task, string>;
  // `showUpDate` is the caller's local today (YYYY-MM-DD); v1 always dates a new
  // task today, but the field is explicit so a future reschedule can pass another
  // day without changing this seam.
  add: (text: string, showUpDate: string) => Transaction;
  complete: (id: string) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The sync write messages that reconcile the synced base to the server's open
// task list: update each row already present, insert each new one, and delete
// any key the server no longer returns (a completed task). Pure so the diff is
// unit-tested without the persistence stack.
export type TaskWrite =
  | { type: "insert" | "update"; value: Task }
  | { type: "delete"; key: string };
export function tasksReconcileWrites(
  currentKeys: Iterable<string>,
  server: readonly Task[],
): TaskWrite[] {
  const present = new Set(currentKeys);
  const serverIds = new Set(server.map((t) => t.id));
  const writes: TaskWrite[] = [];
  for (const t of server) {
    writes.push({ type: present.has(t.id) ? "update" : "insert", value: t });
  }
  for (const key of present) {
    if (!serverIds.has(key)) writes.push({ type: "delete", key });
  }
  return writes;
}

const noopWarn: WarnFn = () => {};

// The react-query key the collection reads through. Distinct from the Capture
// key so the two collections never share a cache entry.
export const TASKS_QUERY_KEY = ["tasks"];
const SCHEMA_VERSION = 1;

// The optimistic row's id is a client-minted UUID the server persists verbatim,
// so this id never changes: no temp-to-real swap, no flicker. `safeRandomUUID`
// works on browser and React Native.
function optimisticTask(text: string, showUpDate: string): Task {
  return {
    id: safeRandomUUID(),
    text,
    showUpDate,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

function markCompleted(draft: Task): void {
  draft.completedAt = new Date().toISOString();
}

type TaskWriteUtils = {
  writeUpsert: (data: Task | Task[]) => void;
  writeDelete: (keys: string | string[]) => void;
  writeBatch: (cb: () => void) => void;
};
function writeUtils(
  collection: Collection<Task, string>,
): TaskWriteUtils | undefined {
  return (collection as { utils?: Partial<TaskWriteUtils> }).utils as
    | TaskWriteUtils
    | undefined;
}

// Reconcile the synced base to the server's authoritative result, in place, by
// each row's stable id. Every write handler calls this AFTER its REST call and
// BEFORE it returns (before the optimistic overlay is released), so the base
// already holds the server's row/deletion when the overlay drops. That is what
// prevents flicker. See captures/collection.ts for the full rationale.
function reconcile(
  collection: Collection<Task, string>,
  delta: { upsert?: Task[]; remove?: string[] },
): void {
  const utils = writeUtils(collection);
  if (!utils) return;
  utils.writeBatch(() => {
    if (delta.upsert?.length) utils.writeUpsert(delta.upsert);
    if (delta.remove?.length) utils.writeDelete(delta.remove);
  });
}

// Fallback: an in-memory Query Collection whose own handlers call the REST API
// and roll back on failure. Used when durable persistence is unavailable
// (private browsing on web, or the jest / no-native-SQLite environment) so the
// Today list never hard-crashes; offline writes are not durable in this mode.
export function createInMemoryTasksApi(deps: {
  queryClient: QueryClient;
  rest: TasksRest;
}): TasksApi {
  const { queryClient, rest } = deps;
  const collection = createCollection(
    queryCollectionOptions({
      queryClient,
      queryKey: TASKS_QUERY_KEY,
      queryFn: () => rest.fetchTasks(),
      getKey: (t: Task) => t.id,
      onInsert: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          const real = await rest.addTask({
            id: m.modified.id,
            text: m.modified.text,
            showUpDate: m.modified.showUpDate,
          });
          reconcile(collection, { upsert: [real] });
        }
        return { refetch: false };
      },
      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          if (m.modified.completedAt != null) {
            const updated = await rest.completeTask(String(m.key));
            reconcile(collection, { upsert: [updated] });
          }
        }
        return { refetch: false };
      },
    }),
  );

  const refetchUtil = (
    collection as { utils?: { refetch?: () => Promise<unknown> } }
  ).utils?.refetch;

  return {
    collection,
    add: (text, showUpDate) =>
      collection.insert(optimisticTask(text, showUpDate)),
    complete: (id) => collection.update(id, markCompleted),
    offline: false,
    refetch: async () => {
      if (refetchUtil) {
        await refetchUtil();
      } else {
        await queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
      }
    },
    getLoadError: () => {
      const state = queryClient.getQueryState(TASKS_QUERY_KEY);
      return state?.status === "error" && state.error
        ? messageOf(state.error)
        : null;
    },
    subscribeLoadError: (cb) => queryClient.getQueryCache().subscribe(cb),
  };
}

// Durable offline mode: local-first. A persisted SQLite collection whose custom
// sync marks ready from the local snapshot immediately, then fetches the open
// task list in the background and reconciles it into the synced base. Writes go
// through an offline outbox that retries when the network returns. This is a
// sibling of createPersistedApi in captures/collection.ts; see that file for the
// full readiness/flicker rationale.
export function createPersistedTasksApi(deps: {
  queryClient: QueryClient;
  rest: TasksRest;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): TasksApi {
  const { rest, persistence, startOfflineExecutor, onWarn = noopWarn } = deps;

  type SyncStart = Parameters<SyncConfig<Task, string>["sync"]>[0];
  type Controls = Pick<SyncStart, "begin" | "write" | "commit">;
  let controls: Controls | null = null;

  let loadError: string | null = null;
  const errorListeners = new Set<() => void>();
  const setLoadError = (next: string | null) => {
    if (next === loadError) return;
    loadError = next;
    for (const cb of errorListeners) cb();
  };

  let collection: Collection<Task, string>;

  const reconcileOne = (t: Task) => {
    if (!controls) return;
    controls.begin();
    controls.write({
      type: collection.has(t.id) ? "update" : "insert",
      value: t,
    });
    controls.commit();
  };

  const reconcileList = (server: Task[]) => {
    if (!controls) return;
    controls.begin();
    for (const write of tasksReconcileWrites(collection.keys(), server)) {
      controls.write(write);
    }
    controls.commit();
  };

  const fetchAndReconcile = async () => {
    try {
      const rows = await rest.fetchTasks();
      setLoadError(null);
      reconcileList(rows);
    } catch (err) {
      setLoadError(messageOf(err));
    }
  };

  const sync: SyncConfig<Task, string> = {
    sync: (params) => {
      controls = {
        begin: params.begin,
        write: params.write,
        commit: params.commit,
      };
      params.markReady();
      void fetchAndReconcile();
      return () => {
        controls = null;
      };
    },
  };

  collection = createCollection(
    persistedCollectionOptions<Task, string>({
      id: "tasks",
      getKey: (t: Task) => t.id,
      schemaVersion: SCHEMA_VERSION,
      persistence,
      sync,
    }),
  );

  const offline = startOfflineExecutor({
    collections: { tasks: collection },
    mutationFns: {
      addTask: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          const id = m.modified.id;
          const text = m.modified.text;
          const showUpDate = m.modified.showUpDate;
          if (
            typeof id === "string" &&
            typeof text === "string" &&
            typeof showUpDate === "string"
          ) {
            const real = await rest.addTask({ id, text, showUpDate });
            reconcileOne(real);
          }
        }
        await fetchAndReconcile();
      },
      completeTask: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          if (m.modified.completedAt != null) {
            const updated = await rest.completeTask(String(m.key));
            reconcileOne(updated);
          }
        }
        await fetchAndReconcile();
      },
    },
    onLeadershipChange: (isLeader) => {
      if (!isLeader) {
        onWarn(
          "today: another instance holds the offline outbox; this one is online-only",
        );
      }
    },
  });

  const addAction = offline.createOfflineAction<{
    text: string;
    showUpDate: string;
  }>({
    mutationFnName: "addTask",
    onMutate: ({ text, showUpDate }) => {
      collection.insert(optimisticTask(text, showUpDate));
    },
  });
  const completeAction = offline.createOfflineAction<{ id: string }>({
    mutationFnName: "completeTask",
    onMutate: ({ id }) => {
      collection.update(id, markCompleted);
    },
  });

  return {
    collection,
    add: (text, showUpDate) => addAction({ text, showUpDate }),
    complete: (id) => completeAction({ id }),
    offline: true,
    refetch: () => fetchAndReconcile(),
    getLoadError: () => loadError,
    subscribeLoadError: (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
  };
}

// Build the Task data layer: try durable offline persistence, fall back to the
// in-memory Query Collection if persistence cannot start (private browsing / no
// native SQLite). `persistence` is a thunk because opening the local database is
// async and may throw.
export async function createTasksApi(deps: {
  queryClient: QueryClient;
  rest: TasksRest;
  persistence?: () =>
    | Promise<PersistedCollectionPersistence>
    | PersistedCollectionPersistence;
  startOfflineExecutor?: StartOfflineExecutor;
  onWarn?: WarnFn;
}): Promise<TasksApi> {
  const {
    queryClient,
    rest,
    persistence,
    startOfflineExecutor,
    onWarn = noopWarn,
  } = deps;
  if (persistence && startOfflineExecutor) {
    try {
      const resolved = await persistence();
      return createPersistedTasksApi({
        queryClient,
        rest,
        persistence: resolved,
        startOfflineExecutor,
        onWarn,
      });
    } catch (err) {
      onWarn(
        "today: offline SQL persistence unavailable, using in-memory fallback",
        err,
      );
    }
  }
  return createInMemoryTasksApi({ queryClient, rest });
}
