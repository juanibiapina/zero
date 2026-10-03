import { describe, expect, it, jest } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import { createMergeableStore, type MergeableContent } from 'tinybase';
import { createCustomPersister, Persists } from 'tinybase/persisters';

import {
  createTaskdoPersistence,
  createTaskdoReplicaOpener,
  type MobileTaskdoPersistence,
} from '../taskdo-replica';

const NOW = '2026-09-27T12:00:00.000Z';
type TaskdoPersister = ReturnType<
  Parameters<typeof createTaskdoPersistence>[0]['createPersister']>;

function persistence(
  load: MobileTaskdoPersistence['load'] = async () => {},
): MobileTaskdoPersistence {
  return {
    store: createMergeableStore(),
    load: jest.fn(load),
    save: jest.fn(async () => {}),
    startAutoPersisting: jest.fn(async () => {}),
    destroy: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  };
}

function sqlitePersistence(
  persistedContent: unknown,
  onIgnoredError: (error: unknown) => void,
) {
  const store = createMergeableStore();
  let content = persistedContent;
  const database = {
    closeAsync: jest.fn(async () => {}),
  };
  const persistence = createTaskdoPersistence({
    store,
    close: () => database.closeAsync(),
    createPersister: (handleIgnoredError) => createCustomPersister<undefined, Persists.StoreOrMergeableStore>(
      store,
      async () => content as MergeableContent,
      async (getContent) => { content = getContent(); },
      async () => undefined,
      async () => {},
      handleIgnoredError,
      Persists.StoreOrMergeableStore,
    ) as unknown as TaskdoPersister,
    onIgnoredError,
  });
  return { persistence, store, getPersistedContent: () => content };
}

describe('mobile TaskDO SQLite persistence', () => {
  it.each(['disk notification', 'explicit refresh'] as const)(
    'preserves acknowledged mutations during an overlapping %s', async (trigger) => {
    const store = createMergeableStore();
    let content = store.getMergeableContent();
    let notify: (() => Promise<unknown>) | undefined;
    let blockReads = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const persistence = createTaskdoPersistence({
      store,
      close: async () => {},
      onIgnoredError: (error) => { throw error; },
      createPersister: (handleIgnoredError) => createCustomPersister<undefined, Persists.StoreOrMergeableStore>(
        store,
        async () => {
          const captured = content;
          if (blockReads) await gate;
          return captured;
        },
        async (getContent) => { content = JSON.parse(JSON.stringify(getContent())) as MergeableContent; },
        async (listener) => { notify = listener as typeof notify; return undefined; },
        async () => { notify = undefined; },
        handleIgnoredError,
        Persists.StoreOrMergeableStore,
      ) as unknown as TaskdoPersister,
    });
    await persistence.load();
    await persistence.startAutoPersisting();
    blockReads = true;
    const staleRead = trigger === 'explicit refresh' ? persistence.load() : notify?.();
    await Promise.resolve();
    store.setRow('tasks', 'new', { text: 'Saved offline task', createdAt: NOW });
    await persistence.save();
    release();
    await staleRead;
    await persistence.destroy();
    await persistence.close();
    const restored = createMergeableStore().setMergeableContent(content);
    expect(restored.getRow('tasks', 'new')).toEqual({ text: 'Saved offline task', createdAt: NOW });
  });

  it('initializes genuinely empty storage with durable empty mergeable content', async () => {
    const ignoredErrors: unknown[] = [];
    const { persistence, store, getPersistedContent } = sqlitePersistence(
      null,
      (error) => ignoredErrors.push(error),
    );

    await persistence.load();
    await persistence.startAutoPersisting();

    expect(store.getMergeableContent()).toEqual([[{}, '', 0], [{}, '', 0]]);
    expect(getPersistedContent()).toEqual(store.getMergeableContent());
    expect(ignoredErrors).toEqual([]);
    await persistence.destroy();
    await persistence.close();
  });

  it('loads existing valid mergeable content instead of the empty default', async () => {
    const seededStore = createMergeableStore().setRow(
      'tasks',
      'existing',
      { text: 'Persisted task', createdAt: NOW },
    );
    const ignoredErrors: unknown[] = [];
    const { persistence, store } = sqlitePersistence(
      seededStore.getMergeableContent(),
      (error) => ignoredErrors.push(error),
    );

    await persistence.load();

    expect(store.getRow('tasks', 'existing')).toMatchObject({ text: 'Persisted task' });
    expect(ignoredErrors).toEqual([]);
    await persistence.destroy();
    await persistence.close();
  });
});

describe('mobile TaskDO replica opener', () => {
  it('rejects a Task save when the real persister reports an ignored disk error', async () => {
    let failWrite = false;
    const durability: [boolean, string | null][] = [];
    const open = createTaskdoReplicaOpener({
      openPersistence: async (_name, onIgnoredError) => {
        const store = createMergeableStore();
        let content = store.getMergeableContent();
        return createTaskdoPersistence({
          store, close: async () => {}, onIgnoredError,
          createPersister: (handleIgnoredError) => createCustomPersister<undefined, Persists.StoreOrMergeableStore>(
            store, async () => content,
            async (getContent) => { if (failWrite) throw new Error('disk full'); content = getContent() as MergeableContent; },
            async () => undefined, async () => {}, handleIgnoredError, Persists.StoreOrMergeableStore,
          ) as unknown as TaskdoPersister,
        });
      },
      openSocket: jest.fn<() => Promise<WebSocket>>(),
      subscribeToForeground: () => () => {},
    });
    const replica = await open({
      descriptor: { version: 1, databaseName: 'taskdo-workspace-guest.sqlite', binding: { kind: 'unbound' } },
      getToken: async () => null, queryClient: new QueryClient(),
      onSnapshot: () => {}, onConnection: () => {},
      onDurability: (durable, error) => durability.push([durable, error]),
    });
    failWrite = true;
    try {
      await expect(replica.tasks.add('Not durable').isPersisted.promise).rejects.toThrow('Offline persistence failed');
      expect(durability.at(-1)).toEqual([false, 'Offline durability is unavailable: disk full']);
    } finally {
      await replica.close();
    }
  });

  it('rejects a mismatched bound database before opening SQLite', async () => {
    const openPersistence = jest.fn(async () => persistence());
    const open = createTaskdoReplicaOpener({
      openPersistence,
      openSocket: jest.fn<() => Promise<WebSocket>>(),
      subscribeToForeground: () => () => {},
    });

    await expect(open({
      descriptor: {
        version: 1,
        databaseName: 'taskdo-fixture-account-B.sqlite',
        binding: { kind: 'bound', accountId: 'account-A' },
      },
      getToken: jest.fn(async () => 'token'),
      queryClient: new QueryClient(),
      onSnapshot: () => {},
      onConnection: () => {},
    })).rejects.toThrow('Todo workspace database does not match its binding');
    expect(openPersistence).not.toHaveBeenCalled();
  });

  it('loads a durable guest workspace before publishing it and never touches auth or sockets', async () => {
    const disk = persistence(async function load(this: MobileTaskdoPersistence) {
      this.store.setRow('tasks', 'existing', { text: 'Existing', createdAt: NOW });
    });
    const openSocket = jest.fn<() => Promise<WebSocket>>();
    const getToken = jest.fn(async () => 'token');
    const connections: boolean[] = [];
    const snapshots: number[] = [];
    const open = createTaskdoReplicaOpener({
      openPersistence: async () => disk,
      openSocket,
      subscribeToForeground: () => () => {},
    });

    const replica = await open({
      descriptor: {
        version: 1,
        databaseName: 'taskdo-workspace-guest.sqlite',
        binding: { kind: 'unbound' },
      },
      getToken,
      queryClient: new QueryClient(),
      onSnapshot: (snapshot) => snapshots.push(snapshot.tasks.length),
      onConnection: (connected) => connections.push(connected),
    });

    expect(replica.snapshot().tasks).toMatchObject([{ id: 'existing', text: 'Existing' }]);
    expect(snapshots).toEqual([1]);
    expect(connections).toEqual([false]);
    expect(openSocket).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    await replica.close();
  });

  it('persists guest mutations through the ordinary screen replica interface', async () => {
    const disk = persistence();
    const open = createTaskdoReplicaOpener({
      openPersistence: async () => disk,
      openSocket: jest.fn<() => Promise<WebSocket>>(),
      subscribeToForeground: () => () => {},
    });
    const replica = await open({
      descriptor: {
        version: 1,
        databaseName: 'taskdo-workspace-guest.sqlite',
        binding: { kind: 'unbound' },
      },
      getToken: jest.fn(async () => null),
      queryClient: new QueryClient(),
      onSnapshot: () => {},
      onConnection: () => {},
    });

    await replica.tasks.add('Offline task').isPersisted.promise;

    expect(replica.snapshot().tasks).toMatchObject([{ text: 'Offline task' }]);
    expect(disk.save).toHaveBeenCalled();
    await replica.close();
  });

  it('surfaces a guest persistence failure from the mutation transaction', async () => {
    const disk = persistence();
    disk.save = jest.fn(async () => { throw new Error('disk full'); });
    const durability: [boolean, string | null][] = [];
    const open = createTaskdoReplicaOpener({
      openPersistence: async () => disk,
      openSocket: jest.fn<() => Promise<WebSocket>>(),
      subscribeToForeground: () => () => {},
    });
    const replica = await open({
      descriptor: {
        version: 1,
        databaseName: 'taskdo-workspace-guest.sqlite',
        binding: { kind: 'unbound' },
      },
      getToken: jest.fn(async () => null),
      queryClient: new QueryClient(),
      onSnapshot: () => {},
      onConnection: () => {},
      onDurability: (durable, error) => durability.push([durable, error]),
    });

    await expect(replica.tasks.add('Not durable').isPersisted.promise).rejects.toThrow('disk full');
    expect(durability).toEqual([
      [true, null],
      [false, 'Offline durability is unavailable: disk full'],
    ]);
    await replica.close();
  });

  it('reloads local changes on refresh and publishes the new snapshot', async () => {
    let loads = 0;
    const disk = persistence(async function load(this: MobileTaskdoPersistence) {
      loads++;
      if (loads === 2) {
        this.store.setRow('tasks', 'from-disk', { text: 'From disk', createdAt: NOW });
      }
    });
    const snapshots: number[] = [];
    const open = createTaskdoReplicaOpener({
      openPersistence: async () => disk,
      openSocket: jest.fn<() => Promise<WebSocket>>(),
      subscribeToForeground: () => () => {},
    });
    const replica = await open({
      descriptor: {
        version: 1,
        databaseName: 'taskdo-workspace-guest.sqlite',
        binding: { kind: 'unbound' },
      },
      getToken: jest.fn(async () => null),
      queryClient: new QueryClient(),
      onSnapshot: (snapshot) => snapshots.push(snapshot.tasks.length),
      onConnection: () => {},
    });

    await replica.refresh();

    expect(replica.snapshot().tasks).toMatchObject([{ id: 'from-disk' }]);
    expect(snapshots).toEqual([0, 1]);
    await replica.close();
  });

  it('closes a guest replica and its persistence resources exactly once', async () => {
    const disk = persistence();
    const removeForeground = jest.fn();
    const open = createTaskdoReplicaOpener({
      openPersistence: async () => disk,
      openSocket: jest.fn<() => Promise<WebSocket>>(),
      subscribeToForeground: () => removeForeground,
    });
    const replica = await open({
      descriptor: {
        version: 1,
        databaseName: 'taskdo-workspace-guest.sqlite',
        binding: { kind: 'unbound' },
      },
      getToken: jest.fn(async () => null),
      queryClient: new QueryClient(),
      onSnapshot: () => {},
      onConnection: () => {},
    });

    await Promise.all([replica.close(), replica.close()]);

    expect(disk.destroy).toHaveBeenCalledTimes(1);
    expect(disk.close).toHaveBeenCalledTimes(1);
    expect(removeForeground).not.toHaveBeenCalled();
  });

  it('fails opening instead of exposing a guest replica when durable loading fails', async () => {
    const disk = persistence(async () => { throw new Error('cannot read sqlite'); });
    const open = createTaskdoReplicaOpener({
      openPersistence: async () => disk,
      openSocket: jest.fn<() => Promise<WebSocket>>(),
      subscribeToForeground: () => () => {},
    });

    await expect(open({
      descriptor: {
        version: 1,
        databaseName: 'taskdo-workspace-guest.sqlite',
        binding: { kind: 'unbound' },
      },
      getToken: jest.fn(async () => null),
      queryClient: new QueryClient(),
      onSnapshot: () => {},
      onConnection: () => {},
    })).rejects.toThrow('cannot read sqlite');
    expect(disk.destroy).toHaveBeenCalledTimes(1);
    expect(disk.close).toHaveBeenCalledTimes(1);
  });

  it('reports malformed non-null persisted content as a durability failure', async () => {
    const durability: [boolean, string | null][] = [];
    const open = createTaskdoReplicaOpener({
      openPersistence: async (_databaseName, onIgnoredError) => sqlitePersistence(
        { malformed: true },
        onIgnoredError,
      ).persistence,
      openSocket: jest.fn<() => Promise<WebSocket>>(),
      subscribeToForeground: () => () => {},
    });

    const replica = await open({
      descriptor: {
        version: 1,
        databaseName: 'taskdo-workspace-guest.sqlite',
        binding: { kind: 'unbound' },
      },
      getToken: jest.fn(async () => null),
      queryClient: new QueryClient(),
      onSnapshot: () => {},
      onConnection: () => {},
      onDurability: (durable, error) => durability.push([durable, error]),
    });

    expect(durability).toContainEqual([
      false,
      'Offline durability is unavailable: tinybase:1:[object Object]',
    ]);
    expect(durability).not.toContainEqual([true, null]);
    await replica.close();
  });
});
