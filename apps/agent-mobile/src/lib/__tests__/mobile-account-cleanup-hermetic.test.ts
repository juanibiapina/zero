import { expect, it, jest } from '@jest/globals';
import { deleteTodoWorkspaceDatabase } from '../mobile-account-cleanup';

const mockExec = jest.fn(async (_sql: string) => {});
const mockClose = jest.fn(async () => {});
const mockOpen = jest.fn(async (_name: string, _options: unknown) => ({
  execAsync: mockExec,
  closeAsync: mockClose,
}));
const mockDelete = jest.fn(async (_name: string) => {});

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: (name: string, options: unknown) => mockOpen(name, options),
  deleteDatabaseAsync: (name: string) => mockDelete(name),
}));
jest.mock('../runtime-profile', () => ({
  RUNTIME_PROFILE: {
    hermetic: true,
    storageKeys: {
      timezoneKey: 'timezone',
      iconSuggestionsKey: 'icons',
    },
  },
}));

it('erases the hermetic TinyBase table without asking the dev client to delete an observed file', async () => {
  await deleteTodoWorkspaceDatabase('taskdo-workspace-hermetic-e2e-guest.sqlite');

  expect(mockOpen).toHaveBeenCalledWith(
    'taskdo-workspace-hermetic-e2e-guest.sqlite',
    { useNewConnection: true },
  );
  expect(mockExec).toHaveBeenCalledWith('DROP TABLE IF EXISTS "taskdo_local"');
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(mockDelete).not.toHaveBeenCalled();
});
