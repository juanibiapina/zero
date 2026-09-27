import AsyncStorage from '@react-native-async-storage/async-storage';

const keyFor = (accountId: string) => `zero.todo.last-sync.${accountId}`;

export async function loadLastSync(accountId: string): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(keyFor(accountId));
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export async function saveLastSync(accountId: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(accountId), value);
  } catch {
    // Sync diagnostics must never make the durable workspace unavailable.
  }
}

export async function clearLastSync(accountId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(accountId));
  } catch {
    // Account cleanup remains safe when optional diagnostics cannot be removed.
  }
}
