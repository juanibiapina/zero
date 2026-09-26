import { useAuth } from '@clerk/expo';
import { Redirect } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { HomeAppIconSync } from '../../components/home-app-icon-sync';
import { syncHomeAppIcon } from '../../lib/home-app-icon';
import { useColor } from '../../lib/theme';
import { RUNTIME_PROFILE } from '../../lib/runtime-profile';
import { TodoDataProvider } from '../../lib/todo-data-context';
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
  useEffect(() => {
    if (
      RUNTIME_PROFILE.launcherCountSyncEnabled &&
      isLoaded &&
      !isSignedIn
    ) {
      void syncHomeAppIcon('Default');
    }
  }, [isLoaded, isSignedIn]);

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

  // Home and Projects remain direct destinations. Browse is a stack for
  // secondary destinations, starting with Upcoming. Each trigger matches its
  // route name; Browse owns its own index and pushed screens.
  const tabs = (
      <NativeTabs
        tintColor={accent}
        backgroundColor={surface}
        iconColor={iconColor}
      >
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf="tray.full" md="inbox" />
          <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="projects">
          <NativeTabs.Trigger.Icon sf="folder" md="folder" />
          <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="browse">
          <NativeTabs.Trigger.Icon sf="line.3.horizontal" md="menu" />
          <NativeTabs.Trigger.Label>Browse</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
  );
  return (
    <>
      {RUNTIME_PROFILE.launcherCountSyncEnabled ? <HomeAppIconSync /> : null}
      <TodoDataProvider>{tabs}</TodoDataProvider>
    </>
  );
}
