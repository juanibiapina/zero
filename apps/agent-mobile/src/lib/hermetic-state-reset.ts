import AsyncStorage from '@react-native-async-storage/async-storage';

import { deleteTodoWorkspaceDatabase } from './mobile-account-cleanup';
import { RUNTIME_PROFILE } from './runtime-profile';

const HERMETIC_DATABASES = new Set([
  'taskdo-workspace-hermetic-e2e-guest.sqlite',
  'taskdo-fixture-e2e-account-a.sqlite',
  'taskdo-fixture-e2e-account-b.sqlite',
  'taskdo-fixture-taskdo-proof-mobile.sqlite',
]);

export async function resetHermeticTodoState(): Promise<void> {
  if (!RUNTIME_PROFILE.hermetic) {
    throw new Error('Hermetic state reset is unavailable');
  }
  const { storageKeys } = RUNTIME_PROFILE;
  const stored = await AsyncStorage.getItem(storageKeys.todoWorkspaceKey);
  const selected = new Set<string>();
  if (stored !== null) {
    let databaseName: unknown;
    try {
      databaseName = (JSON.parse(stored) as { databaseName?: unknown }).databaseName;
    } catch {
      // Invalid isolated metadata is still safe to forget.
    }
    if (typeof databaseName === 'string' && HERMETIC_DATABASES.has(databaseName)) {
      selected.add(databaseName);
    }
  }
  // These names exist only in the hermetic profile. Removing all of them also
  // recovers from a prior test process that stopped after forgetting metadata.
  for (const databaseName of HERMETIC_DATABASES) selected.add(databaseName);
  for (const databaseName of selected) await deleteTodoWorkspaceDatabase(databaseName);
  await AsyncStorage.multiRemove([
    storageKeys.todoWorkspaceKey,
    storageKeys.timezoneKey,
    storageKeys.iconSuggestionsKey,
  ]);
}
