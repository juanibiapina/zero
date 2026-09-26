import { QueryClient } from "@tanstack/react-query";
import {
  createTaskdoReplica,
  createTaskdoSyncLifecycle,
  type TaskdoReplica,
  type TodoSnapshot,
} from "@zero/agent-core";
import { createMergeableStore } from "tinybase";
import type { IndexedDbPersister } from "tinybase/persisters/persister-indexed-db";

export const TASKDO_BROWSER_DB_PREFIX = "zero-taskdo-replica-";
const PERSISTENCE_SAFETY_REFRESH_MS = 10_000;

export type BrowserTaskdoReplica = TaskdoReplica & {
  durable: boolean;
  durabilityError: string | null;
};

type OpenBrowserTaskdoReplicaOptions = {
  queryClient?: QueryClient;
  onSnapshot: (snapshot: TodoSnapshot) => void;
  onConnection: (connected: boolean) => void;
  onDurability: (durable: boolean, error: string | null) => void;
};

function taskSyncUrl(): string {
  const url = new URL("/api/task-sync", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown persistence error";
  }
};

export async function openBrowserTaskdoReplica(
  accountId: string,
  { queryClient, onSnapshot, onConnection, onDurability }: OpenBrowserTaskdoReplicaOptions,
): Promise<BrowserTaskdoReplica> {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error("Invalid account identity");
  const replicaQueryClient = queryClient ?? new QueryClient();
  const store = createMergeableStore();
  const dbName = `${TASKDO_BROWSER_DB_PREFIX}${accountId}`;
  const lockName = `${dbName}-persistence`;
  let durabilityError: string | null = null;
  let durable = false;
  let persister: IndexedDbPersister | undefined;
  let persistenceListeners: string[] = [];
  let pendingSave: Promise<unknown> = Promise.resolve();
  let persistenceSafetyRefresh: ReturnType<typeof setInterval> | undefined;
  let persistenceChannel: BroadcastChannel | undefined;
  let stopped = false;
  let mergingPersisted = false;
  let mergePersisted: (() => Promise<void>) | undefined;

  const markPersistenceFailure = (error: unknown) => {
    durable = false;
    durabilityError = `Offline durability is unavailable: ${errorMessage(error)}`;
    onDurability(false, durabilityError);
  };

  const withPersistenceLock = async <T,>(action: () => Promise<T>): Promise<T> => {
    if (!navigator.locks) throw new Error("Web Locks are unavailable");
    return navigator.locks.request(lockName, action);
  };

  const notifyPersistencePeers = () => {
    try {
      persistenceChannel?.postMessage("persisted");
    } catch {
      persistenceChannel?.close();
      persistenceChannel = undefined;
    }
  };

  try {
    if (!globalThis.indexedDB) throw new Error("IndexedDB is unavailable");
    if (!navigator.locks) throw new Error("Web Locks are unavailable");
    const { createIndexedDbPersister } = await import("tinybase/persisters/persister-indexed-db");
    let ignoredError: unknown;
    let initializing = true;
    persister = createIndexedDbPersister(store, dbName, 0.25, (error) => {
      ignoredError = error;
      if (!initializing) markPersistenceFailure(error);
    });
    const activePersister = persister;
    const loadAndMerge = async () => {
      const persistedStore = createMergeableStore();
      let loadError: unknown;
      const loader = createIndexedDbPersister(persistedStore, dbName, 0.25, (error) => {
        loadError = error;
      });
      try {
        await loader.load();
        if (loadError) throw loadError instanceof Error ? loadError : new Error(errorMessage(loadError));
        mergingPersisted = true;
        store.merge(persistedStore);
      } finally {
        mergingPersisted = false;
        await loader.destroy();
      }
    };
    mergePersisted = loadAndMerge;
    await withPersistenceLock(async () => {
      try {
        await loadAndMerge();
      } catch (error) {
        ignoredError = error;
      }
    });
    if (ignoredError) {
      // Opening a brand-new IndexedDB creates version 1 before TinyBase has
      // installed its mergeable-content object store. The first save upgrades
      // it to TinyBase's schema; this database prefix is new and never aliases
      // the retired web cache.
      ignoredError = undefined;
      await withPersistenceLock(() => activePersister.save());
    }
    initializing = false;
    if (ignoredError) throw ignoredError instanceof Error ? ignoredError : new Error(errorMessage(ignoredError));
    durable = true;
  } catch (error) {
    durabilityError = `Offline durability is unavailable: ${errorMessage(error)}`;
    await persister?.destroy();
    persister = undefined;
  }
  onDurability(durable, durabilityError);

  const persist = async () => {
    if (!persister || stopped) return;
    // Each tab takes exclusive ownership for one merge-and-save operation.
    // Loading under the same lock folds in another tab's complete mergeable
    // metadata before this tab writes, so concurrent offline changes survive.
    pendingSave = pendingSave.then(() => withPersistenceLock(async () => {
      const activePersister = persister;
      if (!activePersister || !mergePersisted) return;
      await mergePersisted();
      await activePersister.save();
      notifyPersistencePeers();
    })).catch(markPersistenceFailure);
    await pendingSave;
  };

  const refreshPersisted = () => {
    const loadAndMerge = mergePersisted;
    if (!loadAndMerge || stopped) return;
    pendingSave = pendingSave
      .then(() => withPersistenceLock(loadAndMerge))
      .catch(markPersistenceFailure);
  };
  const stopPersistenceSafetyRefresh = () => {
    if (!persistenceSafetyRefresh) return;
    clearInterval(persistenceSafetyRefresh);
    persistenceSafetyRefresh = undefined;
  };
  const startPersistenceSafetyRefresh = () => {
    if (!persister || persistenceSafetyRefresh || document.visibilityState !== "visible") return;
    persistenceSafetyRefresh = setInterval(refreshPersisted, PERSISTENCE_SAFETY_REFRESH_MS);
  };

  let refreshReplica = async () => {};
  const replica = createTaskdoReplica({
    store,
    queryClient: replicaQueryClient,
    queryKeyScope: [accountId],
    save: persist,
    refresh: () => refreshReplica(),
  });
  const unsubscribe = replica.subscribe(onSnapshot);
  if (persister) {
    let queued = false;
    const schedulePersist = () => {
      if (queued || stopped || mergingPersisted) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void persist();
      });
    };
    persistenceListeners = ["tasks", "projects", "conditions"].map((table) =>
      store.addTableListener(table, schedulePersist));
    if (typeof BroadcastChannel !== "undefined") {
      try {
        persistenceChannel = new BroadcastChannel(`${dbName}-changes`);
        persistenceChannel.addEventListener("message", refreshPersisted);
      } catch {
        // The visible-tab safety refresh still provides convergence where a
        // browser or privacy mode exposes but does not permit BroadcastChannel.
      }
    }
    startPersistenceSafetyRefresh();
  }

  const sync = createTaskdoSyncLifecycle({
    store,
    canConnect: () => navigator.onLine,
    onConnection,
    openSocket: () => new WebSocket(taskSyncUrl()),
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      void sync.reconnect();
      refreshPersisted();
      startPersistenceSafetyRefresh();
    } else {
      stopPersistenceSafetyRefresh();
    }
  };
  refreshReplica = async () => {
    refreshPersisted();
    await pendingSave;
    await sync.refresh();
  };
  const onOnline = () => { void sync.reconnect(); };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  sync.start();

  return {
    ...replica,
    durable,
    durabilityError,
    async close() {
      if (stopped) return;
      stopped = true;
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      stopPersistenceSafetyRefresh();
      persistenceChannel?.close();
      await sync.stop();
      unsubscribe();
      for (const listenerId of persistenceListeners) store.delListener(listenerId);
      await pendingSave.catch(() => {});
      await replica.close();
      await persister?.destroy();
    },
  };
}
