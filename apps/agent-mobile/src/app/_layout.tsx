import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { Stack } from 'expo-router';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';

import { CLERK_PUBLISHABLE_KEY } from '@/lib/env';

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
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      tokenCache={tokenCache}
    >
      <KeyboardProvider>
        {/* Honor the OS "reduce motion" setting: disable animations when the
            user asks, keep them otherwise. */}
        <ReducedMotionConfig mode={ReduceMotion.System} />
        <Stack screenOptions={{ headerShown: false }} />
      </KeyboardProvider>
    </ClerkProvider>
  );
}
