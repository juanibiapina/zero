import type { DB } from '@op-engineering/op-sqlite';
import type { OpSQLiteDatabaseLike } from '@tanstack/react-native-db-sqlite-persistence';
import type {
  OnlineDetector,
  StorageAdapter,
} from '@tanstack/offline-transactions';
import { OFFLINE_OUTBOX_VERSION } from '@zero/agent-core';

type ReactNativeSQLitePersistence =
  typeof import('@tanstack/react-native-db-sqlite-persistence')['createReactNativeSQLitePersistence'];
type AppPersistence = ReturnType<ReactNativeSQLitePersistence>;

// One local database file for the whole app. TanStack DB derives a separate
// table per collection from its collection id, so every entity lives in its own
// table inside this single file — no per-entity file is needed.
const DB_NAME = 'zero-app.sqlite';

// One offline write outbox for the whole app, in its own file so a persistence
// schema reset of the data file never wipes queued writes. Every collection's
// executor shares this one store: the outbox namespaces entries by transaction
// id (`tx:` keys) and each executor only replays the transactions it can
// deserialize into its own collections, so one file serves all entities safely.
const OUTBOX_DB_NAME = `zero-app-outbox-v${OFFLINE_OUTBOX_VERSION}.sqlite`;

let persistencePromise: Promise<AppPersistence> | null = null;

// Open the app database once AND build the persistence object once, sharing that
// one object across every collection. One persistence object means one driver
// with one serialization queue, so concurrent transactions from different
// collections never interleave into a nested transaction. Calling
// `createReactNativeSQLitePersistence` per collection would build a fresh queue
// over the same connection and corrupt transactions. All native imports are lazy
// so merely loading this module never touches a native binding.
export function getAppPersistence(): Promise<AppPersistence> {
  if (!persistencePromise) {
    persistencePromise = (async () => {
      const { open } = await import('@op-engineering/op-sqlite');
      const { createReactNativeSQLitePersistence } = await import(
        '@tanstack/react-native-db-sqlite-persistence'
      );
      const database = open({ name: DB_NAME });
      // op-sqlite's DB types execute params as mutable Scalar[]; the adapter
      // wants readonly unknown[]. Structurally compatible; cast across variance.
      return createReactNativeSQLitePersistence({
        database: database as unknown as OpSQLiteDatabaseLike,
      });
    })();
  }
  return persistencePromise;
}

// A key/value StorageAdapter for the offline outbox, backed by op-sqlite. Web
// gets IndexedDB automatically; React Native has none, so the outbox needs an
// explicit adapter.
function makeOpSqliteStorage(db: DB): StorageAdapter {
  db.executeSync(
    'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  );
  return {
    get: async (key) => {
      const res = await db.execute('SELECT v FROM kv WHERE k = ?', [key]);
      const rows = res.rows ?? [];
      return rows.length ? String(rows[0].v) : null;
    },
    set: async (key, value) => {
      await db.execute('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [
        key,
        value,
      ]);
    },
    delete: async (key) => {
      await db.execute('DELETE FROM kv WHERE k = ?', [key]);
    },
    keys: async () => {
      const res = await db.execute('SELECT k FROM kv');
      return (res.rows ?? []).map((r) => String(r.k));
    },
    clear: async () => {
      await db.execute('DELETE FROM kv');
    },
  };
}

// A connectivity detector that treats the device as online as soon as netinfo
// reports a connected transport, without waiting for its slower
// `isInternetReachable` probe. The default RN detector gates on reachability,
// which lags on reconnect, so a queued offline write would not replay until the
// next app launch. Here a reconnect fires listeners promptly and the outbox
// replays; a POST that still fails simply retries.
type NetInfoModule = {
  fetch: () => Promise<{ isConnected: boolean | null }>;
  addEventListener: (
    cb: (s: { isConnected: boolean | null }) => void,
  ) => () => void;
};

function makeLenientOnlineDetector(netInfo: NetInfoModule): OnlineDetector {
  const listeners = new Set<() => void>();
  let online = true;
  const notify = () => {
    for (const l of listeners) {
      try {
        l();
      } catch {
        // a listener throwing must not stop the others
      }
    }
  };
  netInfo
    .fetch()
    .then((s) => {
      online = !!s.isConnected;
    })
    .catch(() => {});
  const unsub = netInfo.addEventListener((s) => {
    const now = !!s.isConnected;
    const was = online;
    online = now;
    if (now && !was) notify();
  });
  return {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    notifyOnline: notify,
    isOnline: () => online,
    dispose: () => {
      unsub();
      listeners.clear();
    },
  };
}

let outboxPromise: Promise<{
  storage: StorageAdapter;
  onlineDetector: OnlineDetector;
}> | null = null;

// Open the shared outbox store and network detector once, reused by every
// collection's offline executor. All native imports are lazy so merely loading
// this module never touches a native binding.
export function getAppOutbox(): Promise<{
  storage: StorageAdapter;
  onlineDetector: OnlineDetector;
}> {
  if (!outboxPromise) {
    outboxPromise = (async () => {
      const { open } = await import('@op-engineering/op-sqlite');
      const netInfo = (await import('@react-native-community/netinfo'))
        .default as unknown as NetInfoModule;
      const outboxDb = open({ name: OUTBOX_DB_NAME });
      return {
        storage: makeOpSqliteStorage(outboxDb),
        onlineDetector: makeLenientOnlineDetector(netInfo),
      };
    })();
  }
  return outboxPromise;
}
