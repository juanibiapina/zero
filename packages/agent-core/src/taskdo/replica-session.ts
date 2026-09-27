import {
  createTaskdoReplica,
  type CreateTaskdoReplicaOptions,
  type TaskdoReplica,
  type TodoSnapshot,
} from "./replica";
import {
  createTaskdoSyncLifecycle,
  type CreateTaskdoSyncLifecycleOptions,
} from "./sync";

export type SyncedTaskdoReplicaSession = TaskdoReplica & {
  checkpoint: () => Promise<void>;
  reconnect: () => Promise<void>;
};

export type CreateSyncedTaskdoReplicaSessionOptions =
  Omit<CreateTaskdoReplicaOptions, "refresh"> & {
    onSnapshot: (snapshot: TodoSnapshot) => void;
    refreshLocal?: () => Promise<void>;
    sync: Omit<CreateTaskdoSyncLifecycleOptions, "store">;
  };

/**
 * Owns the platform-independent lifetime of one local TaskDO replica and its
 * remote synchronizer. Persistence and platform event policy remain with the
 * caller because they differ between browser and native environments.
 */
export function createSyncedTaskdoReplicaSession({
  store,
  queryClient,
  queryKeyScope,
  save,
  onSnapshot,
  refreshLocal,
  sync: syncOptions,
  ...clock
}: CreateSyncedTaskdoReplicaSessionOptions): SyncedTaskdoReplicaSession {
  const persistLocal = save ?? (async () => {});
  let closed = false;
  let sessionOperations: Promise<void> = Promise.resolve();
  const runSessionOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("Replica session is closed"));
    const result = sessionOperations.then(operation);
    sessionOperations = result.then(() => {}, () => {});
    return result;
  };
  let refreshSession = async () => {};
  const replica = createTaskdoReplica({
    store,
    queryClient,
    queryKeyScope,
    save: persistLocal,
    refresh: () => refreshSession(),
    ...clock,
  });
  const unsubscribe = replica.subscribe(onSnapshot);
  const sync = createTaskdoSyncLifecycle({ store, ...syncOptions });
  refreshSession = () => runSessionOperation(async () => {
    await refreshLocal?.();
    await sync.refresh();
  });
  sync.start();

  let closePromise: Promise<void> | undefined;
  return {
    ...replica,
    checkpoint: () => runSessionOperation(async () => {
      await persistLocal();
      await sync.checkpoint();
    }),
    reconnect: () => closed ? Promise.resolve() : runSessionOperation(() => sync.reconnect()),
    close() {
      closePromise ??= (async () => {
        closed = true;
        await sessionOperations;
        await sync.stop();
        unsubscribe();
        await replica.close();
      })();
      return closePromise;
    },
  };
}
