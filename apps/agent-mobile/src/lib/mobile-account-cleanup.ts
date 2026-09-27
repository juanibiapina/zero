import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient } from '@tanstack/react-query';
import { deleteDatabaseAsync } from 'expo-sqlite';

import { clearIconSuggestions } from './icon-suggestions';
import { RUNTIME_PROFILE } from './runtime-profile';

const DATABASE_NAME = /^taskdo-(?:fixture|workspace)-[a-zA-Z0-9_-]+\.sqlite$/;
const ACCOUNT_ID = /^[a-zA-Z0-9_-]+$/;

export async function deleteTodoWorkspaceDatabase(databaseName: string) {
  if (!DATABASE_NAME.test(databaseName)) {
    throw new Error('Refusing to delete an invalid todo workspace database');
  }
  await deleteDatabaseAsync(databaseName);
}

export async function clearMobileAccountCaches(
  accountId: string,
  queryClient: QueryClient,
) {
  if (!ACCOUNT_ID.test(accountId)) throw new Error('Invalid account identity');
  await Promise.all([
    clearIconSuggestions(),
    AsyncStorage.removeItem(RUNTIME_PROFILE.storageKeys.timezoneKey),
  ]);
  queryClient.clear();
}
