import AsyncStorage from '@react-native-async-storage/async-storage';

import { RUNTIME_PROFILE } from './runtime-profile';

export async function resetHermeticTodoState(): Promise<void> {
  if (!RUNTIME_PROFILE.hermetic) {
    throw new Error('Hermetic state reset is unavailable');
  }
  const { storageKeys } = RUNTIME_PROFILE;
  await AsyncStorage.multiRemove([
    storageKeys.todoWorkspaceKey,
    storageKeys.timezoneKey,
    storageKeys.iconSuggestionsKey,
  ]);
}
