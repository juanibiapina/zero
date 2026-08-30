// Fake `@clerk/expo` for the hermetic release E2E build. Metro aliases the real
// module to this one only when EXPO_PUBLIC_E2E_FAKE_AUTH=1 (see metro.config.js),
// so no screen imports change and production builds are untouched. The surface
// is exactly the members the app's four Clerk-importing files use; keep it in
// sync with them, a build error surfaces any missing member immediately.
import type { ReactNode } from 'react';

// The static token the worker's ENVIRONMENT=test bypass trusts as the userId.
// It also names the throwaway Durable Object the release stack writes to.
export const E2E_FAKE_TOKEN = 'e2e-test-user';

export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: true,
    getToken: async () => E2E_FAKE_TOKEN,
    signOut: async () => {},
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
