import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resetHermeticTodoState } from '../hermetic-state-reset';

const mockGetItem = jest.fn<() => Promise<string | null>>();
const mockMultiRemove = jest.fn<(keys: string[]) => Promise<void>>();
const mockDelete = jest.fn<(databaseName: string) => Promise<void>>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: () => mockGetItem(),
  multiRemove: (keys: string[]) => mockMultiRemove(keys),
}));
jest.mock('../mobile-account-cleanup', () => ({
  deleteTodoWorkspaceDatabase: (databaseName: string) => mockDelete(databaseName),
}));
jest.mock('../runtime-profile', () => ({
  RUNTIME_PROFILE: {
    hermetic: true,
    storageKeys: {
      todoWorkspaceKey: 'workspace',
      timezoneKey: 'timezone',
      iconSuggestionsKey: 'icons',
    },
  },
}));

describe('hermetic state reset', () => {
  beforeEach(() => {
    mockGetItem.mockReset();
    mockMultiRemove.mockReset().mockResolvedValue();
    mockDelete.mockReset().mockResolvedValue();
  });

  it('removes only exact hermetic databases and isolated metadata', async () => {
    mockGetItem.mockResolvedValue(JSON.stringify({
      databaseName: 'taskdo-fixture-real-account.sqlite',
    }));

    await resetHermeticTodoState();

    expect(mockDelete.mock.calls.map(([name]) => name)).toEqual([
      'taskdo-workspace-hermetic-e2e-guest.sqlite',
      'taskdo-fixture-e2e-account-a.sqlite',
      'taskdo-fixture-e2e-account-b.sqlite',
      'taskdo-fixture-taskdo-proof-mobile.sqlite',
    ]);
    expect(mockMultiRemove).toHaveBeenCalledWith([
      'workspace', 'timezone', 'icons',
    ]);
  });
});
