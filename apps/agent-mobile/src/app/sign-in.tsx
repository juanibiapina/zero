import { useAuth, useSSO } from '@clerk/expo';
import { Button, Host } from '@expo/ui';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { ReturnHome } from '@/components/return-home';
import { Text } from '@/components/ui/text';
import {
  hermeticSignInRedirect,
  HERMETIC_ACCOUNT_A,
  HERMETIC_ACCOUNT_B,
} from '@/lib/hermetic-auth-control';
import { RUNTIME_PROFILE } from '@/lib/runtime-profile';

// Dismisses the web browser once the OAuth redirect completes.
WebBrowser.maybeCompleteAuthSession();

// Warms up the Android Custom Tab so the OAuth browser opens instantly. No-op on
// iOS/web.
function useWarmUpBrowser() {
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

export default function SignInScreen() {
  useWarmUpBrowser();
  const { isLoaded, isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSignInPress = useCallback(async () => {
    setError(null);
    setBusy(true);
    const redirectUrl = AuthSession.makeRedirectUri({ path: 'sso-callback' });
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl,
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        return; // the updated auth state redirects to home
      }
      setError("Sign-in didn't complete. Please try again.");
    } catch {
      setError('Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [startSSOFlow]);

  const onHermeticSignIn = useCallback(async (accountId: string) => {
    setError(null);
    setBusy(true);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: hermeticSignInRedirect(accountId),
      });
      if (!createdSessionId || !setActive) throw new Error('Fake sign-in failed');
      await setActive({ session: createdSessionId });
    } catch {
      setError('Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [startSSOFlow]);

  // E2E-only: exercises the native OAuth redirect handling (the mechanism that
  // decides whether a completed sign-in reaches the app) without Google. Hidden
  // unless the app is built with EXPO_PUBLIC_E2E=1.
  const onProbePress = useCallback(async () => {
    const redirectUrl = AuthSession.makeRedirectUri({ path: 'sso-callback' });
    const probeStart =
      (process.env.EXPO_PUBLIC_E2E_REDIRECT_URL ??
        'http://10.0.2.2:8080/redirect.html') +
      `?to=${encodeURIComponent(redirectUrl + '?rotating_token_nonce=probe')}`;
    try {
      await WebBrowser.openAuthSessionAsync(probeStart, redirectUrl);
    } catch {
      // Ignored: the probe only verifies the app recovers after the redirect.
    }
  }, []);

  if (isLoaded && isSignedIn) {
    return <ReturnHome />;
  }

  const e2e = process.env.EXPO_PUBLIC_E2E === '1';

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
      <Text variant="title">Zero Agent</Text>
      <Text variant="subtitle">Sign in with your Zero account.</Text>
      {/* Each @expo/ui tree needs its own Host; matchContents sizes it to the
          button so the surrounding RN flex layout is unchanged. */}
      {RUNTIME_PROFILE.hermetic ? (
        <View className="gap-3">
          <Host matchContents>
            <Button
              variant="filled"
              disabled={busy}
              onPress={() => void onHermeticSignIn(HERMETIC_ACCOUNT_A)}
              label="Sign in as Account A"
            />
          </Host>
          <Host matchContents>
            <Button
              variant="outlined"
              disabled={busy}
              onPress={() => void onHermeticSignIn(HERMETIC_ACCOUNT_B)}
              label="Sign in as Account B"
            />
          </Host>
        </View>
      ) : (
        <Host matchContents>
          <Button
            variant="filled"
            disabled={busy}
            onPress={() => void onSignInPress()}
            label={busy ? 'Signing in…' : 'Continue with Google'}
          />
        </Host>
      )}
      {error ? <Text variant="error">{error}</Text> : null}
      {e2e ? (
        <Host matchContents>
          <Button
            variant="outlined"
            onPress={() => void onProbePress()}
            label="Run redirect probe"
          />
        </Host>
      ) : null}
    </View>
  );
}
