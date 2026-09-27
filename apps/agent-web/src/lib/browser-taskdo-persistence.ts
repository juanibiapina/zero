import { createMergeableStore } from "tinybase";
import type { IndexedDbPersister } from "tinybase/persisters/persister-indexed-db";

export const TASKDO_BROWSER_DB_PREFIX = "zero-taskdo-replica-";
const PERSISTENCE_SAFETY_REFRESH_MS = 10_000;

type MergeableStore = ReturnType<typeof createMergeableStore>;

export type BrowserTaskdoPersistence = {
  readonly durable: boolean;
  readonly durabilityError: string | null;
  save: () => Promise<void>;
  refresh: () => Promise<void>;
  setVisible: (visible: boolean) => void;
  close: () => Promise<void>;
};

type OpenBrowserTaskdoPersistenceOptions = {
  accountId: string;
  store: MergeableStore;
  onDurability: (durable: boolean, error: string | null) => void;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown persistence error";
  }
};

export async function openBrowserTaskdoPersistence({
  accountId,
  store,
  onDurability,
}: OpenBrowserTaskdoPersistenceOptions): Promise<BrowserTaskdoPersistence> {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error("Invalid account identity");

  const dbName = `${TASKDO_BROWSER_DB_PREFIX}${accountId}`;
  const lockName = `${dbName}-persistence`;
  let durabilityError: string | null = null;
  let durable = false;
  let persister: IndexedDbPersister | undefined;
  let persistenceListeners: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  let safetyRefresh: ReturnType<typeof setInterval> | undefined;
  let channel: BroadcastChannel | undefined;
  let stopped = false;
  let mergingPersisted = false;
  let mergePersisted: (() => Promise<void>) | undefined;

  const markFailure = (error: unknown) => {
    durable = false;
    durabilityError = `Offline durability is unavailable: ${errorMessage(error)}`;
    onDurability(false, durabilityError);
  };

  const withLock = async <T,>(action: () => Promise<T>): Promise<T> => {
    if (!navigator.locks) throw new Error("Web Locks are unavailable");
    return navigator.locks.request(lockName, action);
  };

  const notifyPeers = () => {
    try {
      channel?.postMessage("persisted");
    } catch {
      channel?.close();
      channel = undefined;
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
      if (!initializing) markFailure(error);
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
    await withLock(async () => {
      try {
        await loadAndMerge();
      } catch (error) {
        ignoredError = error;
      }
    });
    if (ignoredError) {
      // A new IndexedDB reaches version 1 before TinyBase installs its object
      // store. The first save upgrades that database to TinyBase's schema.
      ignoredError = undefined;
      await withLock(() => activePersister.save());
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

  const save = async () => {
    if (!persister || stopped) return;
    pending = pending.then(() => withLock(async () => {
      const activePersister = persister;
      if (!activePersister || !mergePersisted) return;
      await mergePersisted();
      await activePersister.save();
      notifyPeers();
    })).catch(markFailure);
    await pending;
  };

  const refresh = async () => {
    const loadAndMerge = mergePersisted;
    if (!loadAndMerge || stopped) return;
    pending = pending.then(() => withLock(loadAndMerge)).catch(markFailure);
    await pending;
  };

  const stopSafetyRefresh = () => {
    if (!safetyRefresh) return;
    clearInterval(safetyRefresh);
    safetyRefresh = undefined;
  };
  const startSafetyRefresh = () => {
    if (!persister || safetyRefresh || document.visibilityState !== "visible" || stopped) return;
    safetyRefresh = setInterval(() => void refresh(), PERSISTENCE_SAFETY_REFRESH_MS);
  };
  const setVisible = (visible: boolean) => {
    if (stopped) return;
    if (visible) {
      void refresh();
      startSafetyRefresh();
    } else {
      stopSafetyRefresh();
    }
  };

  if (persister) {
    let queued = false;
    const scheduleSave = () => {
      if (queued || stopped || mergingPersisted) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void save();
      });
    };
    persistenceListeners = ["tasks", "projects", "conditions"].map((table) =>
      store.addTableListener(table, scheduleSave));
    if (typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(`${dbName}-changes`);
        channel.addEventListener("message", () => void refresh());
      } catch {
        // Visible-tab safety refresh provides eventual convergence when
        // BroadcastChannel is exposed but unavailable.
      }
    }
    startSafetyRefresh();
  }

  return {
    get durable() { return durable; },
    get durabilityError() { return durabilityError; },
    save,
    refresh,
    setVisible,
    async close() {
      if (stopped) return;
      stopped = true;
      stopSafetyRefresh();
      channel?.close();
      for (const listenerId of persistenceListeners) store.delListener(listenerId);
      persistenceListeners = [];
      await pending.catch(() => {});
      await persister?.destroy();
      persister = undefined;
    },
  };
}
