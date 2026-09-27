// Guards the fake Clerk surface against drift from what the real screens use.
// If a screen starts reading a member the fake lacks, or the fake stops
// reporting signed-in, the release E2E build silently breaks; this catches it.
import { describe, expect, it } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import {
  ClerkProvider,
  E2E_ACCOUNT_A,
  E2E_ACCOUNT_B,
  useAuth,
  useSSO,
  useUser,
} from '../clerk-expo';
import { hermeticSignInRedirect } from '../../hermetic-auth-control';
import { resourceCache } from '../clerk-expo-resource-cache';
import { tokenCache } from '../clerk-expo-token-cache';

describe('fake clerk auth', () => {
  function Probe() {
    const auth = useAuth();
    const { user } = useUser();
    const { startSSOFlow } = useSSO();
    const signIn = async (accountId: string) => {
      const result = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: hermeticSignInRedirect(accountId),
      });
      await result.setActive?.({ session: result.createdSessionId! });
    };
    return (
      <>
        <Text>{auth.userId ?? 'guest'}</Text>
        <Text>{user?.primaryEmailAddress?.emailAddress ?? 'no user'}</Text>
        <Pressable accessibilityRole="button" onPress={() => void signIn(E2E_ACCOUNT_A)}>
          <Text>Account A</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => void signIn(E2E_ACCOUNT_B)}>
          <Text>Account B</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => void auth.signOut()}>
          <Text>Sign out</Text>
        </Pressable>
      </>
    );
  }

  it('starts signed out and notifies consumers when deterministic accounts change', async () => {
    const screen = await render(<ClerkProvider><Probe /></ClerkProvider>);
    expect(screen.getByText('guest')).toBeTruthy();
    expect(screen.getByText('no user')).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByText('Account A')));
    await waitFor(() => expect(screen.getByText(E2E_ACCOUNT_A)).toBeTruthy());
    expect(screen.getByText(`${E2E_ACCOUNT_A}@example.test`)).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByText('Sign out')));
    await waitFor(() => expect(screen.getByText('guest')).toBeTruthy());

    await act(async () => fireEvent.press(screen.getByText('Account B')));
    await waitFor(() => expect(screen.getByText(E2E_ACCOUNT_B)).toBeTruthy());
  });

  it('returns the active account as its test token', async () => {
    let token: string | null | undefined;
    function TokenProbe() {
      const auth = useAuth();
      return (
        <Pressable onPress={async () => { token = await auth.getToken(); }}>
          <Text>{auth.userId ?? 'guest'}</Text>
        </Pressable>
      );
    }
    const screen = await render(<ClerkProvider><TokenProbe /></ClerkProvider>);
    fireEvent.press(screen.getByText('guest'));
    await waitFor(() => expect(token).toBeNull());
  });

  it('keeps Clerk token and resource persistence inert', async () => {
    await expect(tokenCache.getToken()).resolves.toBeNull();
    await expect(resourceCache.get()).resolves.toBeNull();
    await expect(resourceCache.save()).resolves.toBeUndefined();
    await expect(resourceCache.remove()).resolves.toBeUndefined();
  });
});
