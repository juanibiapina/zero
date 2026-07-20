import { useAuth, useSSO } from '@clerk/clerk-expo';
import * as AuthSession from 'expo-auth-session';
import { Redirect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

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
        return; // the auth gate redirects to home
      }
      setError("Sign-in didn't complete. Please try again.");
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
    return <Redirect href="/" />;
  }

  const e2e = process.env.EXPO_PUBLIC_E2E === '1';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Zero Agent</Text>
      <Text style={styles.subtitle}>Sign in with your Zero account.</Text>
      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        disabled={busy}
        onPress={() => void onSignInPress()}
      >
        <Text style={styles.buttonText}>
          {busy ? 'Signing in…' : 'Continue with Google'}
        </Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {e2e ? (
        <Pressable style={styles.probeButton} onPress={() => void onProbePress()}>
          <Text style={styles.buttonText}>Run redirect probe</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 16,
    color: '#444',
  },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#208AEF',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  probeButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#888',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  error: {
    fontSize: 14,
    color: '#b00020',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
});
