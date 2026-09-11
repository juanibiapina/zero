import { useAuth } from '@clerk/expo';
import { Redirect } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { useColor } from '../../lib/theme';
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
  const accent = useColor('--color-accent');
  const surface = useColor('--color-surface');
  const iconColor = useColor('--color-foreground-secondary');

  useTimezoneSync(isLoaded && isSignedIn);

  if (!isLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (!isSignedIn) {
    return <Redirect href="/sign-in" />;
  }

  // Three sections: Home (the single task list), Upcoming (future-dated tasks,
  // grouped by day), and Projects (outcome-oriented containers). Each
  // tab is a screen file whose name matches its Trigger `name`, so a new tab is a
  // new file plus one more Trigger. NativeTabs
  // is a native navigator, so its first use needs a fresh EAS dev build to
  // appear on device (pure-JS reload will not show it).
  return (
    <NativeTabs tintColor={accent} backgroundColor={surface} iconColor={iconColor}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="tray.full" md="inbox" />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="upcoming">
        <NativeTabs.Trigger.Icon sf="calendar" md="calendar_month" />
        <NativeTabs.Trigger.Label>Upcoming</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="projects">
        <NativeTabs.Trigger.Icon sf="folder" md="folder" />
        <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
