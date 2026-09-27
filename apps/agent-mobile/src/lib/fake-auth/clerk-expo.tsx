// Fake `@clerk/expo` for the hermetic E2E profile. Metro aliases the real
// module to this one only when EXPO_PUBLIC_HERMETIC_E2E=1 (see metro.config.js),
// so no screen imports change and production builds are untouched. The surface
// is exactly the members the app's four Clerk-importing files use; keep it in
// sync with them, a build error surfaces any missing member immediately.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  accountFromHermeticSignInRedirect,
  HERMETIC_ACCOUNT_A,
  HERMETIC_ACCOUNT_B,
} from '../hermetic-auth-control';

// The extended persistence proof starts in its dedicated account. Ordinary
// hermetic behavior starts signed out and chooses Account A or B through UI.
const INITIAL_ACCOUNT = process.env.EXPO_PUBLIC_TASKDO_PROOF === '1'
  ? 'taskdo-proof-mobile'
  : null;
export const E2E_ACCOUNT_A = HERMETIC_ACCOUNT_A;
export const E2E_ACCOUNT_B = HERMETIC_ACCOUNT_B;

type FakeAuth = {
  accountId: string | null;
  setAccountId: (accountId: string | null) => void;
};

const FakeAuthContext = createContext<FakeAuth | null>(null);

function useFakeAuth(): FakeAuth {
  const auth = useContext(FakeAuthContext);
  if (!auth) throw new Error('Fake Clerk hooks require ClerkProvider');
  return auth;
}

export function ClerkProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(INITIAL_ACCOUNT);
  const value = useMemo(() => ({ accountId, setAccountId }), [accountId]);
  return <FakeAuthContext.Provider value={value}>{children}</FakeAuthContext.Provider>;
}

export function useAuth() {
  const { accountId, setAccountId } = useFakeAuth();
  const getToken = useCallback(async () => accountId, [accountId]);
  const signOut = useCallback(async () => setAccountId(null), [setAccountId]);
  return {
    isLoaded: true,
    isSignedIn: accountId !== null,
    userId: accountId,
    getToken,
    signOut,
  };
}

export function useUser() {
  const { accountId } = useFakeAuth();
  return {
    user: accountId === null ? null : {
      fullName: accountId === E2E_ACCOUNT_A
        ? 'E2E Account A'
        : accountId === E2E_ACCOUNT_B ? 'E2E Account B' : 'E2E test user',
      imageUrl: null,
      primaryEmailAddress: { emailAddress: `${accountId}@example.test` },
    },
  };
}

export function useSSO() {
  const { setAccountId } = useFakeAuth();
  return {
    startSSOFlow: async ({ redirectUrl }: { strategy?: string; redirectUrl: string }) => {
      const accountId = accountFromHermeticSignInRedirect(redirectUrl);
      if (!accountId) {
        return { createdSessionId: null, setActive: undefined };
      }
      return {
        createdSessionId: accountId,
        setActive: async ({ session }: { session: string }) => {
          if (session !== accountId) throw new Error('Unknown fake Clerk session');
          setAccountId(accountId);
        },
      };
    },
  };
}
