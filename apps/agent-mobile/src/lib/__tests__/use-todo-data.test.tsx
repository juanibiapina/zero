import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { TaskdoReplica } from '@zero/agent-core';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { RUNTIME_PROFILE } from '../runtime-profile';
import { useTodoData } from '../use-todo-data';

const mockAuth = { userId: 'A' as string | null };
const mockGetToken = jest.fn(async () => 'token');
const mockQueryClient = {};
const mockOpenReplica = jest.fn();

jest.mock('@clerk/expo', () => ({
  useAuth: () => ({ userId: mockAuth.userId, getToken: mockGetToken }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}));
jest.mock('../taskdo-replica', () => ({
  openTaskDOReplica: (...args: unknown[]) => mockOpenReplica(...args),
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

  it('opens the adopted database and refuses a later different Clerk account', async () => {
    const order: string[] = [];
    mockOpenReplica.mockImplementation(async (databaseName, accountId) => {
      order.push(`database ${String(databaseName)}`);
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
