import { AppState } from 'react-native';
import { createMergeableStore, type MergeableStore } from 'tinybase';
import type { QueryClient } from '@tanstack/react-query';
import {
  createSyncedTaskdoReplicaSession,
  createTaskdoReplica,
  type TaskdoReplica,
} from '@zero/agent-core';

import type { TokenGetter } from './api';
import { API_BASE_URL } from './env';
import type { TodoWorkspaceDescriptor } from './todo-workspace';

export type MobileTaskdoPersistence = {
  store: MergeableStore;
  load: () => Promise<unknown>;
  save: () => Promise<unknown>;
  startAutoPersisting: () => Promise<unknown>;
  destroy: () => Promise<unknown>;
  close: () => Promise<unknown>;
};

type OpenTaskdoReplicaOptions = {
  descriptor: TodoWorkspaceDescriptor;
  getToken: TokenGetter;
  queryClient: QueryClient;
  onSnapshot: Parameters<TaskdoReplica['subscribe']>[0];
  onConnection: (connected: boolean) => void;
  onDurability?: (durable: boolean, error: string | null) => void;
};

type CreateTaskdoReplicaOpenerOptions = {
  openPersistence: (
    databaseName: string,
    onIgnoredError: (error: unknown) => void,
  ) => Promise<MobileTaskdoPersistence>;
  openSocket: (accountId: string, getToken: TokenGetter) => Promise<WebSocket>;
  subscribeToForeground: (onActive: () => void) => () => void;
};

function assertDatabaseName(databaseName: string) {
  if (!/^taskdo-(?:fixture|workspace)-[a-zA-Z0-9_-]+\.sqlite$/.test(databaseName)) {
    throw new Error('Invalid todo workspace database name');
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createTaskdoReplicaOpener({
  openPersistence,
  openSocket,
  subscribeToForeground,
}: CreateTaskdoReplicaOpenerOptions) {
  return async ({
    descriptor,
    getToken,
    queryClient,
    onSnapshot,
    onConnection,
    onDurability = () => {},
  }: OpenTaskdoReplicaOptions): Promise<TaskdoReplica> => {
    assertDatabaseName(descriptor.databaseName);
    if (
      descriptor.binding.kind === 'bound'
      && !/^[a-zA-Z0-9_-]+$/.test(descriptor.binding.accountId)
    ) {
      throw new Error('Invalid account identity');
    }
    if (
      descriptor.binding.kind === 'bound'
      && descriptor.databaseName.startsWith('taskdo-fixture-')
      && descriptor.databaseName !== `taskdo-fixture-${descriptor.binding.accountId}.sqlite`
    ) {
      throw new Error('Todo workspace database does not match its binding');
    }
    if (
      descriptor.binding.kind === 'unbound'
      && !descriptor.databaseName.startsWith('taskdo-workspace-')
    ) {
      throw new Error('Todo workspace database does not match its binding');
    }

    let durabilityFailures = 0;
    const markDurabilityFailure = (error: unknown) => {
      durabilityFailures++;
      onDurability(false, `Offline durability is unavailable: ${errorMessage(error)}`);
    };
    const failuresBeforeOpen = durabilityFailures;
    const persistence = await openPersistence(descriptor.databaseName, markDurabilityFailure);
    const persist = async () => {
      const failuresBeforeSave = durabilityFailures;
      try {
        await persistence.save();
        if (durabilityFailures === failuresBeforeSave) onDurability(true, null);
      } catch (error) {
        markDurabilityFailure(error);
        throw error;
      }
    };
    const reload = async () => {
      try {
        await persistence.load();
      } catch (error) {
        markDurabilityFailure(error);
        throw error;
      }
    };
    let replica: TaskdoReplica | undefined;
    let removeForeground = () => {};
    let unsubscribe = () => {};
    try {
      await reload();
      try {
        await persistence.startAutoPersisting();
      } catch (error) {
        markDurabilityFailure(error);
        throw error;
      }
      if (durabilityFailures === failuresBeforeOpen) onDurability(true, null);

      if (descriptor.binding.kind === 'unbound') {
        replica = createTaskdoReplica({
          store: persistence.store,
          queryClient,
          queryKeyScope: [descriptor.databaseName],
          save: persist,
          refresh: reload,
        });
        unsubscribe = replica.subscribe(onSnapshot);
        onConnection(false);
      } else {
        const accountId = descriptor.binding.accountId;
        const session = createSyncedTaskdoReplicaSession({
          store: persistence.store,
          queryClient,
          queryKeyScope: [accountId],
          save: persist,
          onSnapshot,
          refreshLocal: reload,
          sync: {
            onConnection,
            openSocket: () => openSocket(accountId, getToken),
          },
        });
        replica = session;
        removeForeground = subscribeToForeground(() => { void session.reconnect(); });
      }

      const openedReplica = replica;
      let closePromise: Promise<void> | undefined;
      return {
        ...openedReplica,
        close() {
          closePromise ??= (async () => {
            removeForeground();
            unsubscribe();
            await openedReplica.close();
            await persistence.destroy();
            await persistence.close();
          })();
          return closePromise;
        },
      };
    } catch (error) {
      removeForeground();
      unsubscribe();
      await replica?.close();
      await persistence.destroy();
      await persistence.close();
      throw error;
    }
  };
}

const openTaskdoPersistence = async (
  databaseName: string,
  onIgnoredError: (error: unknown) => void,
): Promise<MobileTaskdoPersistence> => {
  const [{ openDatabaseAsync }, { createExpoSqlitePersister }] = await Promise.all([
    import('expo-sqlite'),
    import('tinybase/persisters/persister-expo-sqlite'),
  ]);
  const database = await openDatabaseAsync(databaseName);
  const store = createMergeableStore();
  const persister = createExpoSqlitePersister(
    store,
    database,
    'taskdo_local',
    undefined,
    onIgnoredError,
  );
  return {
    store,
    load: () => persister.load(),
    save: () => persister.save(),
    startAutoPersisting: () => persister.startAutoPersisting(),
    destroy: () => persister.destroy(),
    close: () => database.closeAsync(),
  };
};

const openAuthenticatedSocket = async (_accountId: string, getToken: TokenGetter) => {
  const token = await getToken();
  if (!token) throw new Error('Signed out');
  const url = `${API_BASE_URL.replace(/^http/, 'ws')}/api/task-sync`;
  // React Native WebSocket's third argument supports authentication headers.
  return new (WebSocket as unknown as new (
    url: string,
    protocols: string[],
    options: { headers: Record<string, string> },
  ) => WebSocket)(url, [], {
    headers: { Authorization: `Bearer ${token}` },
  });
};

export const openTaskDOReplica = createTaskdoReplicaOpener({
  openPersistence: openTaskdoPersistence,
  openSocket: openAuthenticatedSocket,
  subscribeToForeground: (onActive) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') onActive();
    });
    return () => subscription.remove();
  },
});
