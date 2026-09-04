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
// the Capture and Task data layers (not domain-specific), so the Project layer
// reuses them instead of re-declaring them. The domain logic below is a
// deliberate sibling of tasks/collection.ts; extract a shared base at the
// Rule-of-Three follow-up, per docs/todo-app.md.
import type { StartOfflineExecutor, WarnFn } from "../captures/collection";
import type { Project } from "./types";

// The name-only creation defaults, matching what the server fills. Kept here so
// the optimistic row is identical to the server row (no temp-to-real swap).
const DEFAULT_ICON = "📁";

// The two REST calls the A1 collection needs, already auth-bound by the caller.
// Web injects same-origin cookie closures (no token); mobile injects closures
// that carry the Clerk Bearer token. setStatus (A2) and edit (A3) extend this.
export type ProjectsRest = {
  fetchProjects: () => Promise<Project[]>;
  // The client mints the project's id (a stable UUID), so the optimistic row and
  // the server's row share one key and the server dedupes on the id: a retried
  // add (offline outbox replay) re-sends the same id and gets the stored row
  // back, not a second project.
  addProject: (project: { id: string; title: string }) => Promise<Project>;
};

// One handle over the Project data layer. Both Projects screens read
// `collection` through a live query and write with `add`, which returns the
// underlying transaction so the page can surface a write error via
// `tx.isPersisted.promise`.
export type ProjectsApi = {
  collection: Collection<Project, string>;
  add: (title: string) => Transaction;
  offline: boolean;
  refetch: () => Promise<void>;
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The sync write messages that reconcile the synced base to the server's project
// list: update each row already present, insert each new one, and delete any key
// the server no longer returns. Pure so the diff is unit-tested without the
// persistence stack.
export type ProjectWrite =
  | { type: "insert" | "update"; value: Project }
  | { type: "delete"; key: string };
export function projectsReconcileWrites(
  currentKeys: Iterable<string>,
  server: readonly Project[],
): ProjectWrite[] {
  const present = new Set(currentKeys);
  const serverIds = new Set(server.map((p) => p.id));
  const writes: ProjectWrite[] = [];
  for (const p of server) {
    writes.push({ type: present.has(p.id) ? "update" : "insert", value: p });
  }
  for (const key of present) {
    if (!serverIds.has(key)) writes.push({ type: "delete", key });
  }
  return writes;
}

const noopWarn: WarnFn = () => {};

// The react-query key the collection reads through. Distinct from the Capture
// and Task keys so the collections never share a cache entry.
export const PROJECTS_QUERY_KEY = ["projects"];
const SCHEMA_VERSION = 1;

// The optimistic row's id is a client-minted UUID the server persists verbatim,
// so this id never changes: no temp-to-real swap, no flicker. The other fields
// match the server's creation defaults (icon 📁, description null, status next).
// `safeRandomUUID` works on browser and React Native.
function optimisticProject(title: string): Project {
  return {
    id: safeRandomUUID(),
    title,
    icon: DEFAULT_ICON,
    description: null,
    status: "next",
    createdAt: new Date().toISOString(),
  };
}

type ProjectWriteUtils = {
  writeUpsert: (data: Project | Project[]) => void;
  writeDelete: (keys: string | string[]) => void;
  writeBatch: (cb: () => void) => void;
};
function writeUtils(
  collection: Collection<Project, string>,
): ProjectWriteUtils | undefined {
  return (collection as { utils?: Partial<ProjectWriteUtils> }).utils as
    | ProjectWriteUtils
    | undefined;
}

// Reconcile the synced base to the server's authoritative result, in place, by
// each row's stable id. Every write handler calls this AFTER its REST call and
// BEFORE it returns (before the optimistic overlay is released), so the base
// already holds the server's row when the overlay drops. That is what prevents
// flicker. See tasks/collection.ts for the full rationale.
function reconcile(
  collection: Collection<Project, string>,
  delta: { upsert?: Project[]; remove?: string[] },
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
// Projects list never hard-crashes; offline writes are not durable in this mode.
export function createInMemoryProjectsApi(deps: {
  queryClient: QueryClient;
  rest: ProjectsRest;
}): ProjectsApi {
  const { queryClient, rest } = deps;
  const collection = createCollection(
    queryCollectionOptions({
      queryClient,
      queryKey: PROJECTS_QUERY_KEY,
      queryFn: () => rest.fetchProjects(),
      getKey: (p: Project) => p.id,
      onInsert: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          const real = await rest.addProject({
            id: m.modified.id,
            title: m.modified.title,
          });
          reconcile(collection, { upsert: [real] });
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
    add: (title) => collection.insert(optimisticProject(title)),
    offline: false,
    refetch: async () => {
      if (refetchUtil) {
        await refetchUtil();
      } else {
        await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
      }
    },
    getLoadError: () => {
      const state = queryClient.getQueryState(PROJECTS_QUERY_KEY);
      return state?.status === "error" && state.error
        ? messageOf(state.error)
        : null;
    },
    subscribeLoadError: (cb) => queryClient.getQueryCache().subscribe(cb),
  };
}

// Durable offline mode: local-first. A persisted SQLite collection whose custom
// sync marks ready from the local snapshot immediately, then fetches the project
// list in the background and reconciles it into the synced base. Writes go
// through an offline outbox that retries when the network returns. This is a
// sibling of createPersistedTasksApi; see that file for the full
// readiness/flicker rationale.
export function createPersistedProjectsApi(deps: {
  queryClient: QueryClient;
  rest: ProjectsRest;
  persistence: PersistedCollectionPersistence;
  startOfflineExecutor: StartOfflineExecutor;
  onWarn?: WarnFn;
}): ProjectsApi {
  const { rest, persistence, startOfflineExecutor, onWarn = noopWarn } = deps;

  type SyncStart = Parameters<SyncConfig<Project, string>["sync"]>[0];
  type Controls = Pick<SyncStart, "begin" | "write" | "commit">;
  let controls: Controls | null = null;

  let loadError: string | null = null;
  const errorListeners = new Set<() => void>();
  const setLoadError = (next: string | null) => {
    if (next === loadError) return;
    loadError = next;
    for (const cb of errorListeners) cb();
  };

  // Forward-referenced by the closures below and assigned once after
  // `createCollection` returns; it cannot be `const` because `sync` (passed into
  // `createCollection`) reads it back through `reconcileList`.
  // eslint-disable-next-line prefer-const
  let collection: Collection<Project, string>;

  const reconcileOne = (p: Project) => {
    if (!controls) return;
    controls.begin();
    controls.write({
      type: collection.has(p.id) ? "update" : "insert",
      value: p,
    });
    void controls.commit();
  };

  const reconcileList = (server: Project[]) => {
    if (!controls) return;
    controls.begin();
    for (const write of projectsReconcileWrites(collection.keys(), server)) {
      controls.write(write);
    }
    void controls.commit();
  };

  const fetchAndReconcile = async () => {
    try {
      const rows = await rest.fetchProjects();
      setLoadError(null);
      reconcileList(rows);
    } catch (err) {
      setLoadError(messageOf(err));
    }
  };

  const sync: SyncConfig<Project, string> = {
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
    persistedCollectionOptions<Project, string>({
      id: "projects",
      getKey: (p: Project) => p.id,
      schemaVersion: SCHEMA_VERSION,
      persistence,
      sync,
    }),
  );

  const offline = startOfflineExecutor({
    collections: { projects: collection },
    mutationFns: {
      addProject: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          const id = m.modified.id;
          const title = m.modified.title;
          if (typeof id === "string" && typeof title === "string") {
            const real = await rest.addProject({ id, title });
            reconcileOne(real);
          }
        }
        await fetchAndReconcile();
      },
    },
    onLeadershipChange: (isLeader) => {
      if (!isLeader) {
        onWarn(
          "projects: another instance holds the offline outbox; this one is online-only",
        );
      }
    },
  });

  const addAction = offline.createOfflineAction<{ title: string }>({
    mutationFnName: "addProject",
    onMutate: ({ title }) => {
      collection.insert(optimisticProject(title));
    },
  });

  return {
    collection,
    add: (title) => addAction({ title }),
    offline: true,
    refetch: () => fetchAndReconcile(),
    getLoadError: () => loadError,
    subscribeLoadError: (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
  };
}

// Build the Project data layer: try durable offline persistence, fall back to
// the in-memory Query Collection if persistence cannot start (private browsing /
// no native SQLite). `persistence` is a thunk because opening the local database
// is async and may throw.
export async function createProjectsApi(deps: {
  queryClient: QueryClient;
  rest: ProjectsRest;
  persistence?: () =>
    | Promise<PersistedCollectionPersistence>
    | PersistedCollectionPersistence;
  startOfflineExecutor?: StartOfflineExecutor;
  onWarn?: WarnFn;
}): Promise<ProjectsApi> {
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
      return createPersistedProjectsApi({
        queryClient,
        rest,
        persistence: resolved,
        startOfflineExecutor,
        onWarn,
      });
    } catch (err) {
      onWarn(
        "projects: offline SQL persistence unavailable, using in-memory fallback",
        err,
      );
    }
  }
  return createInMemoryProjectsApi({ queryClient, rest });
}
