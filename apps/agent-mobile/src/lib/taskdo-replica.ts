import { AppState } from 'react-native';
import { createMergeableStore } from 'tinybase';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';

import { API_BASE_URL } from './env';
import type { TokenGetter } from './api';

export type LooseTask = { id: string; text: string; createdAt: string; showUpDate: string | null };

export async function openTaskDOReplica(
  accountId: string,
  getToken: TokenGetter,
  onTasks: (tasks: LooseTask[]) => void,
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
  const snapshot = () => {
    const rows = store.getTable('tasks');
    onTasks(Object.entries(rows).flatMap(([id, row]) =>
      typeof row.text === 'string' && typeof row.createdAt === 'string' && !row.completedAt
        ? [{ id, text: row.text, createdAt: row.createdAt, showUpDate: typeof row.showUpDate === 'string' ? row.showUpDate : null }]
        : [],
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  };
  const listenerId = store.addTableListener('tasks', snapshot);
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
    async add(id: string, text: string, createdAt: string, showUpDate: string | null) {
      store.setRow('tasks', id, {
        text,
        createdAt,
        ...(showUpDate ? { showUpDate } : {}),
      });
      await persister.save();
    },
    async edit(id: string, text: string) {
      if (!store.hasRow('tasks', id)) throw new Error('Task not found');
      store.setCell('tasks', id, 'text', text);
      await persister.save();
    },
    async close() {
      stopped = true;
      foreground.remove();
      if (retry) clearTimeout(retry);
      socket?.close();
      await sync?.destroy();
      store.delListener(listenerId);
      await persister.destroy();
      await db.closeAsync();
    },
  };
}
