import { useAuth } from '@clerk/expo';
import { Redirect, Stack } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';

import { createMobileTimezoneSync } from '../../lib/timezone-sync';

// Keep the server's stored timezone equal to this device's, silently. Built once
// inside the signed-in tree (where the Clerk token getter is valid); getToken is
// read through a ref so the sync is not rebuilt on a new function identity.
function useTimezoneSync(enabled: boolean): void {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    if (!enabled) return;
    const sync = createMobileTimezoneSync(() => getTokenRef.current());
    void sync.onColdStart();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sync.onForeground();
    });
    return () => subscription.remove();
  }, [enabled]);
}

export default function SignedInLayout() {
  const { isLoaded, isSignedIn } = useAuth();

  useTimezoneSync(isLoaded && isSignedIn);

  if (!isLoaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!isSignedIn) {
    return <Redirect href="/sign-in" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
