import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { RUNTIME_PROFILE } from '../runtime-profile';
import {
  clearMobileAccountCaches,
  deleteTodoWorkspaceDatabase,
} from '../mobile-account-cleanup';

const mockDeleteDatabase = jest.fn(async (_name: string) => {});
jest.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: (name: string) => mockDeleteDatabase(name),
}));

describe('mobile account cleanup', () => {
  beforeEach(async () => {
    mockDeleteDatabase.mockClear();
    await AsyncStorage.clear();
  });

  it('deletes only a validated todo workspace database name', async () => {
    await expect(deleteTodoWorkspaceDatabase('../other.sqlite')).rejects.toThrow(
      'Refusing to delete',
    );
    expect(mockDeleteDatabase).not.toHaveBeenCalled();

    await deleteTodoWorkspaceDatabase('taskdo-fixture-account-A.sqlite');
    expect(mockDeleteDatabase).toHaveBeenCalledWith('taskdo-fixture-account-A.sqlite');
  });

  it('clears account-only device caches and query state', async () => {
    await AsyncStorage.multiSet([
      [RUNTIME_PROFILE.storageKeys.timezoneKey, 'Europe/Berlin'],
      [RUNTIME_PROFILE.storageKeys.iconSuggestionsKey, '{}'],
    ]);
    const client = new QueryClient();
    client.setQueryData(['taskdo', 'account-A', 'tasks'], [{ id: 'task' }]);

    await clearMobileAccountCaches('account-A', client);

    await expect(AsyncStorage.multiGet([
      RUNTIME_PROFILE.storageKeys.timezoneKey,
      RUNTIME_PROFILE.storageKeys.iconSuggestionsKey,
    ])).resolves.toEqual([
      [RUNTIME_PROFILE.storageKeys.timezoneKey, null],
      [RUNTIME_PROFILE.storageKeys.iconSuggestionsKey, null],
    ]);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
