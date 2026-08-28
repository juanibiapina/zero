import type { DB } from '@op-engineering/op-sqlite';
import type { OpSQLiteDatabaseLike } from '@tanstack/react-native-db-sqlite-persistence';
import type {
  OnlineDetector,
  StorageAdapter,
} from '@tanstack/offline-transactions';
import type { QueryClient } from '@tanstack/react-query';
import {
  createCapturesApi,
  type CapturesApi,
  type CapturesRest,
  type StartOfflineExecutor,
} from '@zero/agent-core';

import { addCapture, fetchInbox, processCapture, type TokenGetter } from './api';

const DB_NAME = 'zero-inbox.sqlite';
const OUTBOX_DB_NAME = 'zero-inbox-outbox.sqlite';

// Bind the cross-origin REST helpers to the current Clerk token getter so the
// shared factory stays auth-agnostic.
function makeRest(getToken: TokenGetter): CapturesRest {
  return {
    fetchInbox: () => fetchInbox(getToken),
    addCapture: (capture) => addCapture(getToken, capture),
    processCapture: (id) => processCapture(getToken, id),
  };
}

// A key/value StorageAdapter for the offline outbox, backed by op-sqlite. Web
// gets IndexedDB automatically; React Native has none, so the outbox needs an
// explicit adapter. It lives in its own database file so a persistence schema
// reset never wipes queued writes.
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

// Build the mobile Capture data layer: durable offline SQLite (op-sqlite) plus an
// outbox that retries over the native network detector. Falls back to the shared
// in-memory Query Collection when the native modules are unavailable (e.g. under
// jest), so tests need no op-sqlite mock. All native imports are lazy so merely
// loading this module never touches a native binding.
export function createMobileCapturesApi(deps: {
  queryClient: QueryClient;
  getToken: TokenGetter;
}): Promise<CapturesApi> {
  // Stashed during the async persistence step, then used by the synchronous
  // startOfflineExecutor the shared factory calls (only on the durable path).
  let startExecutor: StartOfflineExecutor | null = null;

  return createCapturesApi({
    queryClient: deps.queryClient,
    rest: makeRest(deps.getToken),
    persistence: async () => {
      const { open } = await import('@op-engineering/op-sqlite');
      const { createReactNativeSQLitePersistence } = await import(
        '@tanstack/react-native-db-sqlite-persistence'
      );
      const rn = await import('@tanstack/offline-transactions/react-native');
      const netInfo = (await import('@react-native-community/netinfo'))
        .default as unknown as NetInfoModule;

      const outboxDb = open({ name: OUTBOX_DB_NAME });
      const storage = makeOpSqliteStorage(outboxDb);
      const onlineDetector = makeLenientOnlineDetector(netInfo);
      startExecutor = (config) =>
        rn.startOfflineExecutor({ ...config, storage, onlineDetector });

      const database = open({ name: DB_NAME });
      // op-sqlite's DB types execute params as mutable Scalar[]; the adapter wants
      // readonly unknown[]. Structurally compatible; cast across the variance.
      return createReactNativeSQLitePersistence({
        database: database as unknown as OpSQLiteDatabaseLike,
      });
    },
    startOfflineExecutor: (config) => {
      if (!startExecutor) {
        throw new Error('offline executor not initialized before use');
      }
      return startExecutor(config);
    },
    onWarn: (message, error) => console.warn(message, error),
  });
}
