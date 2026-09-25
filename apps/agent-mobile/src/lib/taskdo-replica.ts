import { AppState } from 'react-native';
import { createMergeableStore, type MergeableStore } from 'tinybase';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';

import { API_BASE_URL } from './env';
import type { TokenGetter } from './api';
import { projectFixture, type FixtureSnapshot } from './taskdo-projection';

export async function openTaskDOReplica(
  accountId: string,
  getToken: TokenGetter,
  onSnapshot: (snapshot: FixtureSnapshot) => void,
  onConnection: (connected: boolean) => void,
) {
  // No shared filename and no anonymous replica: switching accounts cannot
  // hydrate another user's Tasks, even before an online connection succeeds.
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('Invalid account identity');
  const [{ openDatabaseAsync }, { createExpoSqlitePersister }] = await Promise.all([
    import('expo-sqlite'),
    import('tinybase/persisters/persister-expo-sqlite'),
  ]);
  const db = await openDatabaseAsync(`taskdo-fixture-${accountId}.sqlite`);
  const store = createMergeableStore();
  const persister = createExpoSqlitePersister(store, db, 'taskdo_local');
  await persister.startAutoPersisting();
  const snapshot = () => onSnapshot(projectFixture(store));
  const listeners = ['tasks', 'task-edits', 'projects', 'conditions'].map((table) => store.addTableListener(table, snapshot));
  snapshot();

  let stopped = false;
  let connecting = false;
  let socket: WebSocket | undefined;
  let sync: Awaited<ReturnType<typeof createWsSynchronizer>> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  const schedule = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = undefined; void connect(); }, delay);
    delay = Math.min(delay * 2, 30_000);
  };
  const connect = async () => {
    if (stopped || connecting || socket?.readyState === WebSocket.OPEN) return;
    connecting = true;
    try {
      const token = await getToken();
      if (!token) throw new Error('Signed out');
      const url = `${API_BASE_URL.replace(/^http/, 'ws')}/api/task-sync`;
      // React Native WebSocket's third argument supports authentication headers.
      const live = new (WebSocket as unknown as new (
        url: string, protocols: string[], options: { headers: Record<string, string> },
      ) => WebSocket)(url, [], { headers: { Authorization: `Bearer ${token}` } });
      socket = live;
      live.addEventListener('close', () => {
        if (socket !== live) return;
        socket = undefined;
        onConnection(false);
        void sync?.destroy().catch(() => {});
        sync = undefined;
        schedule();
      });
      await new Promise<void>((resolve, reject) => {
        live.addEventListener('open', () => resolve(), { once: true });
        live.addEventListener('error', () => reject(new Error('Sync unavailable')), { once: true });
      });
      if (stopped) { live.close(); return; }
      sync = await createWsSynchronizer(store, live);
      await sync.startSync();
      if (stopped || socket !== live) return;
      delay = 1000;
      onConnection(true);
    } catch {
      socket?.close();
      socket = undefined;
      onConnection(false);
      schedule();
    } finally {
      connecting = false;
    }
  };
  const foreground = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      if (retry) clearTimeout(retry);
      retry = undefined;
      void connect();
    }
  });
  void connect();

  return {
    async write(mutate: (mutableStore: MergeableStore) => void) {
      if (stopped) throw new Error('Local account is closed');
      store.transaction(() => mutate(store));
      await persister.save();
    },
    async close() {
      stopped = true;
      foreground.remove();
      if (retry) clearTimeout(retry);
      socket?.close();
      await sync?.destroy();
      for (const listenerId of listeners) store.delListener(listenerId);
      await persister.destroy();
      await db.closeAsync();
    },
  };
}
