import { describe, expect, it, jest } from '@jest/globals';

import { createTodoWorkspaceRegistry } from '../todo-workspace';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: jest.fn(async () => value),
    setItem: jest.fn(async (_key: string, next: string) => { value = next; }),
  };
}

describe('mobile todo workspace registry', () => {
  it('adopts the historical signed-in database before returning it', async () => {
    const storage = memoryStorage();
    const registry = createTodoWorkspaceRegistry({
      storage,
      storageKey: 'workspace',
    });

    await expect(registry.forSignedInAccount('account-A')).resolves.toEqual({
      version: 1,
      databaseName: 'taskdo-fixture-account-A.sqlite',
      binding: { kind: 'bound', accountId: 'account-A' },
    });
    expect(storage.setItem).toHaveBeenCalledWith('workspace', JSON.stringify({
      version: 1,
      databaseName: 'taskdo-fixture-account-A.sqlite',
      binding: { kind: 'bound', accountId: 'account-A' },
    }));
  });

  it('reopens the same persisted workspace without rewriting it', async () => {
    const descriptor = {
      version: 1 as const,
      databaseName: 'taskdo-fixture-account-A.sqlite',
      binding: { kind: 'bound' as const, accountId: 'account-A' },
    };
    const storage = memoryStorage(JSON.stringify(descriptor));
    const registry = createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' });

    await expect(registry.forSignedInAccount('account-A')).resolves.toEqual(descriptor);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('refuses to return a workspace bound to another account', async () => {
    const storage = memoryStorage(JSON.stringify({
      version: 1,
      databaseName: 'taskdo-fixture-account-A.sqlite',
      binding: { kind: 'bound', accountId: 'account-A' },
    }));
    const registry = createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' });

    await expect(registry.forSignedInAccount('account-B')).rejects.toThrow(
      'Todo workspace belongs to a different account',
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('serializes concurrent first opens into one persisted adoption', async () => {
    const storage = memoryStorage();
    const registry = createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' });

    const [first, second] = await Promise.all([
      registry.forSignedInAccount('account-A'),
      registry.forSignedInAccount('account-A'),
    ]);

    expect(first).toEqual(second);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it.each([
    '{not json',
    JSON.stringify({
      version: 1,
      databaseName: '../another-account.sqlite',
      binding: { kind: 'bound', accountId: 'account-A' },
    }),
    JSON.stringify({
      version: 1,
      databaseName: 'taskdo-fixture-account-A.sqlite',
      binding: { kind: 'bound' },
    }),
    JSON.stringify({
      version: 1,
      databaseName: 'taskdo-fixture-account-B.sqlite',
      binding: { kind: 'bound', accountId: 'account-A' },
    }),
  ])('fails closed for corrupt metadata %#', async (stored) => {
    const storage = memoryStorage(stored);
    const registry = createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' });

    await expect(registry.forSignedInAccount('account-A')).rejects.toThrow(
      'Cannot open saved todo workspace: metadata is invalid',
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('never returns one account workspace to a concurrent different account', async () => {
    const storage = memoryStorage();
    const registry = createTodoWorkspaceRegistry({ storage, storageKey: 'workspace' });

    const [first, second] = await Promise.allSettled([
      registry.forSignedInAccount('account-A'),
      registry.forSignedInAccount('account-B'),
    ]);

    expect(first).toMatchObject({
      status: 'fulfilled',
      value: { binding: { kind: 'bound', accountId: 'account-A' } },
    });
    expect(second).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'Todo workspace belongs to a different account',
      }),
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
