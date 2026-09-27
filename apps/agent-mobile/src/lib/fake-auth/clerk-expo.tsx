// Fake `@clerk/expo` for the hermetic E2E profile. Metro aliases the real
// module to this one only when EXPO_PUBLIC_HERMETIC_E2E=1 (see metro.config.js),
// so no screen imports change and production builds are untouched. The surface
// is exactly the members the app's four Clerk-importing files use; keep it in
// sync with them, a build error surfaces any missing member immediately.
import type { ReactNode } from 'react';

// The static token the worker's ENVIRONMENT=test bypass trusts as the userId.
// It also names the throwaway Durable Object the hermetic stack writes to.
export const E2E_FAKE_TOKEN = process.env.EXPO_PUBLIC_TASKDO_PROOF === '1'
  ? 'taskdo-proof-mobile'
  : 'e2e-test-user';

export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: true,
    userId: E2E_FAKE_TOKEN,
    getToken: async () => E2E_FAKE_TOKEN,
    signOut: async () => {},
  };
}

export function useUser() {
  return {
    user: {
      fullName: 'E2E test user',
      imageUrl: null,
      primaryEmailAddress: { emailAddress: `${E2E_FAKE_TOKEN}@example.test` },
    },
  };
}

export function useSSO() {
  return {
    startSSOFlow: async () => ({
      createdSessionId: null,
      setActive: undefined,
    }),
  };
}
