import { AppState } from 'react-native';
import { createMergeableStore } from 'tinybase';
import type { QueryClient } from '@tanstack/react-query';
import {
  createSyncedTaskdoReplicaSession,
  type TaskdoReplica,
} from '@zero/agent-core';

import { API_BASE_URL } from './env';
import type { TokenGetter } from './api';

export async function openTaskDOReplica(
  databaseName: string,
  accountId: string,
  getToken: TokenGetter,
  queryClient: QueryClient,
  onSnapshot: Parameters<TaskdoReplica['subscribe']>[0],
  onConnection: (connected: boolean) => void,
) {
  // The workspace registry chooses the file and verifies its account binding;
  // this adapter independently rejects unsafe identities before touching SQLite.
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('Invalid account identity');
  if (!/^taskdo-(?:fixture|workspace)-[a-zA-Z0-9_-]+\.sqlite$/.test(databaseName)) {
    throw new Error('Invalid todo workspace database name');
  }
  const [{ openDatabaseAsync }, { createExpoSqlitePersister }] = await Promise.all([
    import('expo-sqlite'),
    import('tinybase/persisters/persister-expo-sqlite'),
  ]);
  const db = await openDatabaseAsync(databaseName);
  const store = createMergeableStore();
  const persister = createExpoSqlitePersister(store, db, 'taskdo_local');
  await persister.startAutoPersisting();
  const session = createSyncedTaskdoReplicaSession({
    store,
    queryClient,
    queryKeyScope: [accountId],
    save: () => persister.save(),
    onSnapshot,
    sync: {
      onConnection,
      openSocket: async () => {
        const token = await getToken();
        if (!token) throw new Error('Signed out');
        const url = `${API_BASE_URL.replace(/^http/, 'ws')}/api/task-sync`;
        // React Native WebSocket's third argument supports authentication headers.
        return new (WebSocket as unknown as new (
          url: string, protocols: string[], options: { headers: Record<string, string> },
        ) => WebSocket)(url, [], { headers: { Authorization: `Bearer ${token}` } });
      },
    },
  });
  const foreground = AppState.addEventListener('change', (state) => {
    if (state === 'active') void session.reconnect();
  });

  let closePromise: Promise<void> | undefined;
  return {
    ...session,
    close() {
      closePromise ??= (async () => {
        foreground.remove();
        await session.close();
        await persister.destroy();
        await db.closeAsync();
      })();
      return closePromise;
    },
  };
}
