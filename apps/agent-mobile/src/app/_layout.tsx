import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';

import { CLERK_PUBLISHABLE_KEY } from '@/lib/env';
import { createQueryClient, setupAppStateFocus } from '@/lib/query-client';

// NativeWind: importing the Tailwind entry once at the root registers the
// styles for every className in the app.
import '../../global.css';

export default function RootLayout() {
  // Core 3 requires a non-optional `publishableKey`. Narrow here so the throw
  // also satisfies the type (a module-level check doesn't narrow the usage).
  const publishableKey = CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error(
      'Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY. Set it in the environment (see apps/agent-mobile/README.md).',
    );
  }
  // One client for the app's lifetime; refetch queries on foreground.
  const [queryClient] = useState(createQueryClient);
  useEffect(() => setupAppStateFocus(), []);
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      tokenCache={tokenCache}
    >
      <QueryClientProvider client={queryClient}>
        <KeyboardProvider>
          {/* Honor the OS "reduce motion" setting: disable animations when the
              user asks, keep them otherwise. */}
          <ReducedMotionConfig mode={ReduceMotion.System} />
          <Stack screenOptions={{ headerShown: false }} />
        </KeyboardProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}
