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
  let refreshSession = async () => {};
  const replica = createTaskdoReplica({
    store,
    queryClient,
    queryKeyScope,
    save,
    refresh: () => refreshSession(),
    ...clock,
  });
  const unsubscribe = replica.subscribe(onSnapshot);
  const sync = createTaskdoSyncLifecycle({ store, ...syncOptions });
  refreshSession = async () => {
    await refreshLocal?.();
    await sync.refresh();
  };
  sync.start();

  let closePromise: Promise<void> | undefined;
  return {
    ...replica,
    reconnect: () => sync.reconnect(),
    close() {
      closePromise ??= (async () => {
        await sync.stop();
        unsubscribe();
        await replica.close();
      })();
      return closePromise;
    },
  };
}
