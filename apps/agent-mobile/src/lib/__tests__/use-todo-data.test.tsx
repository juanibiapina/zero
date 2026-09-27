import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { TaskdoReplica } from '@zero/agent-core';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { RUNTIME_PROFILE } from '../runtime-profile';
import type { TodoWorkspaceDescriptor } from '../todo-workspace';
import { useTodoData } from '../use-todo-data';

const mockAuth = { userId: 'A' as string | null };
const mockGetToken = jest.fn(async () => 'token');
const mockSignOut = jest.fn(async () => {});
const mockQueryClient = {};
const mockOpenReplica = jest.fn<(
  options: { descriptor: TodoWorkspaceDescriptor },
) => Promise<TaskdoReplica>>();

jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ userId: mockAuth.userId, getToken: mockGetToken, signOut: mockSignOut }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}));
jest.mock('../taskdo-replica', () => ({
  openTaskDOReplica: (options: { descriptor: TodoWorkspaceDescriptor }) => mockOpenReplica(options),
}));

function replica(accountId: string, close: () => Promise<void>): TaskdoReplica {
  return {
    close,
    snapshot: () => ({
      tasks: [],
      projects: [],
      conditions: [],
      recoveries: [{ table: 'tasks', id: accountId, text: accountId, reason: 'Invalid Task' }],
    }),
  } as unknown as TaskdoReplica;
}

describe('useTodoData', () => {
  beforeEach(async () => {
    mockAuth.userId = 'A';
    mockOpenReplica.mockReset();
    mockGetToken.mockClear();
    await AsyncStorage.clear();
  });

  it('opens guest data while signed out and binds that same database after login', async () => {
    mockAuth.userId = null;
    const order: string[] = [];
    let guestDatabase = '';
    mockOpenReplica.mockImplementation(async ({ descriptor }) => {
      if (descriptor.binding.kind === 'unbound') guestDatabase = descriptor.databaseName;
      order.push(`open ${descriptor.binding.kind} ${descriptor.databaseName}`);
      return replica(
        descriptor.binding.kind === 'bound' ? descriptor.binding.accountId : 'guest',
        async () => { order.push(`close ${descriptor.binding.kind}`); },
      );
    });
    const hook = await renderHook(() => useTodoData());
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.recoveries[0]?.id).toBe('guest');

    mockAuth.userId = 'A';
    await hook.rerender({});
    await waitFor(() => expect(hook.result.current.recoveries[0]?.id).toBe('A'));

    expect(order).toEqual([
      `open unbound ${guestDatabase}`,
      'close unbound',
      `open bound ${guestDatabase}`,
    ]);
    await hook.unmount();
    expect(order).toEqual([
      `open unbound ${guestDatabase}`,
      'close unbound',
      `open bound ${guestDatabase}`,
      'close bound',
    ]);
  });

  it('opens the adopted database and refuses a later different Clerk account', async () => {
    const order: string[] = [];
    mockOpenReplica.mockImplementation(async ({ descriptor }) => {
      if (descriptor.binding.kind !== 'bound') throw new Error('Expected bound workspace');
      const { accountId } = descriptor.binding;
      order.push(`database ${String(descriptor.databaseName)}`);
      order.push(`open ${String(accountId)}`);
      return replica(String(accountId), async () => { order.push(`close ${String(accountId)}`); });
    });
    const hook = await renderHook(() => useTodoData());
    await waitFor(() => expect(hook.result.current.recoveries[0]?.id).toBe('A'));

    mockAuth.userId = 'B';
    await hook.rerender({});
    await waitFor(() => expect(hook.result.current.error).toContain('different account'));
    expect(order).toEqual(['database taskdo-fixture-A.sqlite', 'open A', 'close A']);

    await hook.unmount();
    expect(order).toEqual(['database taskdo-fixture-A.sqlite', 'open A', 'close A']);
  });

  it('never exposes a replica whose account became stale while opening', async () => {
    let finishOpen!: (value: TaskdoReplica) => void;
    const closeA = jest.fn(async () => {});
    mockOpenReplica.mockImplementation(() => new Promise<TaskdoReplica>((resolve) => {
      finishOpen = resolve;
    }));
    const hook = await renderHook(() => useTodoData());
    await waitFor(() => expect(mockOpenReplica).toHaveBeenCalled());

    mockAuth.userId = 'B';
    await hook.rerender({});
    expect(hook.result.current).toMatchObject({
      replica: null,
      ready: false,
      recoveries: [],
    });

    finishOpen(replica('A', closeA));
    await waitFor(() => expect(hook.result.current.error).toContain('different account'));
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toMatchObject({
      replica: null,
      ready: false,
      recoveries: [],
    });

    await hook.unmount();
  });

  it('does not open SQLite when persisted workspace metadata is corrupt', async () => {
    await AsyncStorage.setItem(
      RUNTIME_PROFILE.storageKeys.todoWorkspaceKey,
      '{corrupt',
    );

    const hook = await renderHook(() => useTodoData());
    await waitFor(() => expect(hook.result.current.error).toContain('metadata is invalid'));

    expect(mockOpenReplica).not.toHaveBeenCalled();
    expect(hook.result.current).toMatchObject({ replica: null, ready: false });
    await hook.unmount();
  });
});
