// Polyfill Web Crypto (Hermes has none) before anything builds a collection.
import '@/lib/crypto-polyfill';

import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { resourceCache } from '@clerk/expo/resource-cache';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Toaster } from '@/components/toaster';

import { CLERK_PUBLISHABLE_KEY } from '@/lib/env';
import { createQueryClient, setupAppStateFocus } from '@/lib/query-client';
import { useColor } from '@/lib/theme';

// Uniwind: importing the Tailwind entry once at the root registers the theme
// tokens and styles for every className in the app.
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
  const backgroundColor = useColor('--color-background');
  // One client for the app's lifetime; refetch queries on foreground.
  const [queryClient] = useState(createQueryClient);
  useEffect(() => setupAppStateFocus(), []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor }}>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <ClerkProvider
          publishableKey={publishableKey}
          tokenCache={tokenCache}
          __experimental_resourceCache={resourceCache}
        >
          <QueryClientProvider client={queryClient}>
            <KeyboardProvider>
              {/* Honor the OS "reduce motion" setting: disable animations when the
                  user asks, keep them otherwise. */}
              <ReducedMotionConfig mode={ReduceMotion.System} />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor },
                }}
              />
            </KeyboardProvider>
          </QueryClientProvider>
        </ClerkProvider>
        {/* App-wide toast host. Inside the gesture + safe-area providers so it
            renders above content on every screen. */}
        <Toaster />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
