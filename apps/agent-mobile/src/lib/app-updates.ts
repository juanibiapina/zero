import * as Updates from 'expo-updates';
import { useEffect } from 'react';
import { AppState } from 'react-native';

// expo-updates checks only on a cold launch and applies a download on the next
// one. Android keeps Zero in memory, so that meant closing the app twice. Zero
// also checks whenever it returns to the foreground, and the Home update icon
// restarts into a downloaded update with one tap.

async function downloadUpdate(): Promise<void> {
  const check = await Updates.checkForUpdateAsync();
  if (check.isAvailable) await Updates.fetchUpdateAsync();
}

/** Check for and download an update whenever Zero returns to the foreground. */
export function useUpdateChecksOnForeground(): void {
  useEffect(() => {
    if (!Updates.isEnabled) return;
    const subscription = AppState.addEventListener('change', (state) => {
      // Failures surface through useUpdates() as checkError/downloadError.
      if (state === 'active') downloadUpdate().catch(() => {});
    });
    return () => subscription.remove();
  }, []);
}

/** Restart Zero into the downloaded update. */
export function restartIntoUpdate(): Promise<void> {
  return Updates.reloadAsync();
}
