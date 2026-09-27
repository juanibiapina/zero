import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { TaskdoReplica } from '@zero/agent-core';

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
  beforeEach(() => {
    mockAuth.userId = 'A';
    mockOpenReplica.mockReset();
    mockGetToken.mockClear();
  });

  it('wires Clerk account changes through serialized replica ownership', async () => {
    const order: string[] = [];
    mockOpenReplica.mockImplementation(async (accountId) => {
      order.push(`open ${String(accountId)}`);
      return replica(String(accountId), async () => { order.push(`close ${String(accountId)}`); });
    });
    const hook = await renderHook(() => useTodoData());
    await waitFor(() => expect(hook.result.current.recoveries[0]?.id).toBe('A'));

    mockAuth.userId = 'B';
    await hook.rerender({});
    await waitFor(() => expect(hook.result.current.recoveries[0]?.id).toBe('B'));
    expect(order).toEqual(['open A', 'close A', 'open B']);

    await hook.unmount();
    await waitFor(() => expect(order).toEqual(['open A', 'close A', 'open B', 'close B']));
  });
});
