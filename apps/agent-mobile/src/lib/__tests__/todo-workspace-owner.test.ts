import { describe, expect, it, jest } from '@jest/globals';
import type { TaskdoReplica, TodoSnapshot } from '@zero/agent-core';

import { createTodoWorkspaceOwner } from '../todo-workspace-owner';
import { createTodoWorkspaceRegistry, type TodoWorkspaceDescriptor } from '../todo-workspace';

const EMPTY_SNAPSHOT: TodoSnapshot = {
  tasks: [],
  projects: [],
  conditions: [],
  recoveries: [],
};

function memoryStorage(
  initial: string | null = null,
  onSet: (value: string) => void = () => {},
  onRemove: () => void = () => {},
) {
  let value = initial;
  return {
    getItem: jest.fn(async () => value),
    setItem: jest.fn(async (_key: string, next: string) => {
      onSet(next);
      value = next;
    }),
    removeItem: jest.fn(async () => {
      onRemove();
      value = null;
    }),
  };
}

function replica(close: () => Promise<void> = async () => {}): TaskdoReplica {
  return {
    close,
    snapshot: () => EMPTY_SNAPSHOT,
  } as TaskdoReplica;
}

function syncedReplica({
  checkpoint = async () => {},
  close = async () => {},
}: {
  checkpoint?: () => Promise<void>;
  close?: () => Promise<void>;
} = {}): TaskdoReplica & { checkpoint: () => Promise<void> } {
  return {
    ...replica(close),
    checkpoint,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('mobile todo workspace owner', () => {
  it('signs out only after checkpointing and deleting the validated active workspace', async () => {
    const order: string[] = [];
    const storage = memoryStorage(null, () => {}, () => { order.push('forget'); });
    const registry = createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' });
    const owner = createTodoWorkspaceOwner({
      registry,
      open: async (descriptor) => syncedReplica({
        checkpoint: async () => { order.push('checkpoint'); },
        close: async () => { order.push('close'); },
      }),
      deleteDatabase: async (databaseName) => { order.push(`delete ${databaseName}`); },
      clearAccountCaches: async (accountId) => { order.push(`clear ${accountId}`); },
      signOut: async () => { order.push('signOut'); },
    });
    await owner.setAccount('account-A');

    await owner.signOut();

    expect(order).toEqual([
      'checkpoint',
      'close',
      'delete taskdo-fixture-account-A.sqlite',
      'clear account-A',
      'forget',
      'signOut',
    ]);
    expect(storage.removeItem).toHaveBeenCalledWith('workspace');
    expect(owner.getSnapshot()).toMatchObject({
      accountId: null,
      status: 'guest',
      ready: true,
    });
  });

  it('preserves the active database when its sync checkpoint fails', async () => {
    const storage = memoryStorage();
    const close = jest.fn(async () => {});
    const deleteDatabase = jest.fn(async () => {});
    const signOut = jest.fn(async () => {});
    const owner = createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' }),
      open: async () => syncedReplica({
        checkpoint: async () => { throw new Error('network unavailable'); },
        close,
      }),
      deleteDatabase,
      clearAccountCaches: async () => {},
      signOut,
    });
    await owner.setAccount('account-A');

    await expect(owner.signOut()).rejects.toThrow('network unavailable');

    expect(close).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(owner.getSnapshot()).toMatchObject({ status: 'account', ready: true });
  });

  it('allows an explicit discard after a checkpoint failure', async () => {
    const order: string[] = [];
    const checkpoint = jest.fn(async () => { throw new Error('offline'); });
    const owner = createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({
        storage: memoryStorage(),
        storageKey: 'workspace',
        createWorkspaceId: () => 'fresh-guest',
      }),
      open: async (descriptor) => descriptor.binding.kind === 'bound'
        ? syncedReplica({
            checkpoint,
            close: async () => { order.push('close'); },
          })
        : replica(),
      deleteDatabase: async () => { order.push('delete'); },
      clearAccountCaches: async () => { order.push('clear'); },
      signOut: async () => { order.push('signOut'); },
    });
    await owner.setAccount('account-A');
    await expect(owner.signOut()).rejects.toThrow('offline');

    await owner.signOut({ discardLocalCopy: true });

    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['close', 'delete', 'clear', 'signOut']);
    expect(owner.getSnapshot()).toMatchObject({ status: 'guest', ready: true });
  });

  it('stays locked and retries only Clerk sign-out after local cleanup succeeded', async () => {
    const storage = memoryStorage();
    const deleteDatabase = jest.fn(async () => {});
    const signOut = jest.fn(async () => {
      if (signOut.mock.calls.length === 1) throw new Error('Clerk unavailable');
    });
    const owner = createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({
        storage,
        storageKey: 'workspace',
        createWorkspaceId: () => 'after-retry',
      }),
      open: async (descriptor) => descriptor.binding.kind === 'bound'
        ? syncedReplica()
        : replica(),
      deleteDatabase,
      clearAccountCaches: async () => {},
      signOut,
    });
    await owner.setAccount('account-A');

    await expect(owner.signOut()).rejects.toThrow('Clerk unavailable');
    expect(owner.getSnapshot()).toMatchObject({
      status: 'signing-out',
      replica: null,
      ready: false,
      error: expect.stringContaining('Clerk unavailable'),
    });
    await owner.signOut();

    expect(deleteDatabase).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(owner.getSnapshot()).toMatchObject({ status: 'guest', ready: true });
  });

  it('opens a fresh signed-out workspace as a ready local replica', async () => {
    const opened: TodoWorkspaceDescriptor[] = [];
    const registry = createTodoWorkspaceRegistry({
      storage: memoryStorage(),
      storageKey: 'workspace',
      createWorkspaceId: () => 'guest-123',
    });
    const guestReplica = replica();
    const owner = createTodoWorkspaceOwner({
      registry,
      open: async (descriptor) => {
        opened.push(descriptor);
        return guestReplica;
      },
    });

    await owner.setAccount(null);

    expect(opened).toEqual([{
      version: 1,
      databaseName: 'taskdo-workspace-guest-123.sqlite',
      binding: { kind: 'unbound' },
    }]);
    expect(owner.getSnapshot()).toMatchObject({
      status: 'guest',
      replica: guestReplica,
      ready: true,
      connected: false,
      error: null,
    });
  });

  it('reopens the same guest database after an owner restart', async () => {
    const storage = memoryStorage();
    const opened: string[] = [];
    const makeOwner = () => createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({
        storage,
        storageKey: 'workspace',
        createWorkspaceId: () => 'stable',
      }),
      open: async (descriptor) => {
        opened.push(descriptor.databaseName);
        return replica();
      },
    });

    const first = makeOwner();
    await first.setAccount(null);
    await first.close();
    const restarted = makeOwner();
    await restarted.setAccount(null);

    expect(opened).toEqual([
      'taskdo-workspace-stable.sqlite',
      'taskdo-workspace-stable.sqlite',
    ]);
    expect(restarted.getSnapshot()).toMatchObject({ status: 'guest', ready: true });
  });

  it('closes a guest before binding and reopening the same database for sync', async () => {
    const order: string[] = [];
    const storage = memoryStorage(null, (value) => {
      const descriptor = JSON.parse(value) as TodoWorkspaceDescriptor;
      order.push(`persist ${descriptor.binding.kind}`);
    });
    const registry = createTodoWorkspaceRegistry({
      storage,
      storageKey: 'workspace',
      createWorkspaceId: () => 'stable',
    });
    const owner = createTodoWorkspaceOwner({
      registry,
      open: async (descriptor) => {
        order.push(`open ${descriptor.binding.kind} ${descriptor.databaseName}`);
        return replica(async () => { order.push(`close ${descriptor.binding.kind}`); });
      },
    });

    await owner.setAccount(null);
    order.length = 0;
    await owner.setAccount('account-A');

    expect(order).toEqual([
      'close unbound',
      'persist bound',
      'open bound taskdo-workspace-stable.sqlite',
    ]);
    expect(owner.getSnapshot()).toMatchObject({
      accountId: 'account-A',
      status: 'account',
      ready: true,
    });
  });

  it('adopts the historical account database and reopens it for the same account', async () => {
    const storage = memoryStorage();
    const opened: TodoWorkspaceDescriptor[] = [];
    const makeOwner = () => createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' }),
      open: async (descriptor) => {
        opened.push(descriptor);
        return replica();
      },
    });

    const first = makeOwner();
    await first.setAccount('account-A');
    await first.close();
    const restarted = makeOwner();
    await restarted.setAccount('account-A');

    expect(opened).toEqual([
      {
        version: 1,
        databaseName: 'taskdo-fixture-account-A.sqlite',
        binding: { kind: 'bound', accountId: 'account-A' },
      },
      {
        version: 1,
        databaseName: 'taskdo-fixture-account-A.sqlite',
        binding: { kind: 'bound', accountId: 'account-A' },
      },
    ]);
    expect(restarted.getSnapshot()).toMatchObject({ status: 'account', ready: true });
  });

  it('fails closed when a different account tries to open a bound workspace', async () => {
    const storage = memoryStorage(JSON.stringify({
      version: 1,
      databaseName: 'taskdo-fixture-account-A.sqlite',
      binding: { kind: 'bound', accountId: 'account-A' },
    }));
    const open = jest.fn(async () => replica());
    const owner = createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' }),
      open,
    });

    await owner.setAccount('account-B');

    expect(open).not.toHaveBeenCalled();
    expect(owner.getSnapshot()).toMatchObject({
      accountId: 'account-B',
      status: 'mismatch',
      replica: null,
      ready: false,
      error: expect.stringContaining('different account'),
    });
  });

  it('locks a bound workspace when auth disappears without exposing it as guest data', async () => {
    const close = jest.fn(async () => {});
    const opened: TodoWorkspaceDescriptor[] = [];
    const owner = createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({
        storage: memoryStorage(),
        storageKey: 'workspace',
      }),
      open: async (descriptor) => {
        opened.push(descriptor);
        return replica(close);
      },
    });
    await owner.setAccount('account-A');

    await owner.setAccount(null);

    expect(close).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
    expect(owner.getSnapshot()).toMatchObject({
      accountId: null,
      status: 'locked',
      replica: null,
      ready: false,
      error: expect.stringContaining('while signed out'),
    });
  });

  it('closes a stale opening without ever publishing its replica', async () => {
    const guestOpen = deferred<TaskdoReplica>();
    const guestOpenStarted = deferred<void>();
    const closeGuest = jest.fn(async () => {});
    const accountReplica = replica();
    let publishGuestSnapshot: ((snapshot: TodoSnapshot) => void) | undefined;
    const owner = createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({
        storage: memoryStorage(),
        storageKey: 'workspace',
        createWorkspaceId: () => 'stable',
      }),
      open: async (descriptor, events) => {
        if (descriptor.binding.kind === 'bound') return accountReplica;
        publishGuestSnapshot = events.onSnapshot;
        guestOpenStarted.resolve();
        return guestOpen.promise;
      },
    });

    const openingGuest = owner.setAccount(null);
    await guestOpenStarted.promise;
    const openingAccount = owner.setAccount('account-A');
    publishGuestSnapshot?.({
      ...EMPTY_SNAPSHOT,
      recoveries: [{ table: 'tasks', id: 'guest', text: 'guest', reason: 'Invalid Task' }],
    });
    guestOpen.resolve(replica(closeGuest));
    await openingGuest;

    expect(owner.getSnapshot()).toMatchObject({
      accountId: 'account-A',
      status: 'opening',
      replica: null,
      ready: false,
      recoveries: [],
    });
    await openingAccount;
    expect(closeGuest).toHaveBeenCalledTimes(1);
    expect(owner.getSnapshot()).toMatchObject({
      accountId: 'account-A',
      status: 'account',
      replica: accountReplica,
      ready: true,
    });
  });

  it('closes an in-flight replica exactly once and stays closed', async () => {
    const pending = deferred<TaskdoReplica>();
    const openingStarted = deferred<void>();
    const closeReplica = jest.fn(async () => {});
    const owner = createTodoWorkspaceOwner({
      registry: createTodoWorkspaceRegistry({
        storage: memoryStorage(),
        storageKey: 'workspace',
        createWorkspaceId: () => 'stable',
      }),
      open: async () => {
        openingStarted.resolve();
        return pending.promise;
      },
    });
    void owner.setAccount(null);
    await openingStarted.promise;

    const firstClose = owner.close();
    const secondClose = owner.close();
    pending.resolve(replica(closeReplica));
    await Promise.all([firstClose, secondClose]);
    await owner.setAccount('account-A');

    expect(closeReplica).toHaveBeenCalledTimes(1);
    expect(owner.getSnapshot()).toMatchObject({
      status: 'closed',
      replica: null,
      ready: false,
    });
  });
});
