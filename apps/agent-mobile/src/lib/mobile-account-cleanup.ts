import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient } from '@tanstack/react-query';
import { deleteDatabaseAsync, openDatabaseAsync } from 'expo-sqlite';

import { clearIconSuggestions } from './icon-suggestions';
import { RUNTIME_PROFILE } from './runtime-profile';
import { clearLastSync } from './sync-metadata';
import { clearMedicineReminders } from './medicine-reminders';

const DATABASE_NAME = /^taskdo-(?:fixture|workspace)-[a-zA-Z0-9_-]+\.sqlite$/;
const ACCOUNT_ID = /^[a-zA-Z0-9_-]+$/;

export async function deleteTodoWorkspaceDatabase(databaseName: string) {
  if (!DATABASE_NAME.test(databaseName)) {
    throw new Error('Refusing to delete an invalid todo workspace database');
  }
  await clearMedicineReminders(databaseName);
  if (RUNTIME_PROFILE.hermetic) {
    // Expo's development client keeps a diagnostic connection to databases it
    // observes, so deleting the file is rejected even after our owned handle
    // closes. Erase TinyBase's only table instead; the harness deletes the
    // exact test-only file after force-stopping the app.
    const database = await openDatabaseAsync(databaseName, { useNewConnection: true });
    try {
      await database.execAsync('DROP TABLE IF EXISTS "taskdo_local"');
    } finally {
      await database.closeAsync();
    }
    return;
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
    clearLastSync(accountId),
    AsyncStorage.removeItem(RUNTIME_PROFILE.storageKeys.timezoneKey),
  ]);
  queryClient.clear();
}
