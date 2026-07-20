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
  const [status, setStatus] = useState<string | null>(null);

  const onSignInPress = useCallback(async () => {
    setStatus('Opening Google…');
    const redirectUrl = AuthSession.makeRedirectUri({ path: 'sso-callback' });
    try {
      const result = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl,
      });
      const { createdSessionId, setActive, authSessionResult, signIn, signUp } =
        result;
      // Surface the exact outcome so failures are visible without a debugger.
      const diag = [
        `redirect=${redirectUrl}`,
        `browser=${authSessionResult?.type ?? 'none'}`,
        `session=${createdSessionId ?? 'null'}`,
        `signIn=${signIn?.status ?? '-'}`,
        `signUp=${signUp?.status ?? '-'}`,
      ].join('\n');
      console.log('[sso]', diag.replace(/\n/g, ' '));

      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        return; // auth gate will redirect to home
      }
      setStatus(`Not signed in.\n${diag}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('[sso] error', msg);
      setStatus(`Error: ${msg}\nredirect=${redirectUrl}`);
    }
  }, [startSSOFlow]);

  // E2E-only: deterministically exercise the native OAuth redirect capture
  // (the mechanism that decides whether a completed sign-in reaches the app)
  // without Google. Opens a controlled page that redirects to the same
  // `sso-callback` deep link Clerk uses, then reports whether expo-web-browser
  // captured it (type=success) or lost it (type=dismiss).
  const onProbePress = useCallback(async () => {
    setStatus('probe: running');
    const redirectUrl = AuthSession.makeRedirectUri({ path: 'sso-callback' });
    const probeStart =
      (process.env.EXPO_PUBLIC_E2E_REDIRECT_URL ?? 'http://10.0.2.2:8080/redirect.html') +
      `?to=${encodeURIComponent(redirectUrl + '?rotating_token_nonce=probe')}`;
    try {
      const res = await WebBrowser.openAuthSessionAsync(probeStart, redirectUrl);
      const url = 'url' in res ? res.url : undefined;
      const nonce = url ? new URL(url).searchParams.get('rotating_token_nonce') : null;
      console.log('[probe]', JSON.stringify({ type: res.type, url, nonce }));
      setStatus(`probe=${res.type} nonce=${nonce ?? '-'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('[probe] error', msg);
      setStatus(`probe=error ${msg}`);
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
      <Pressable style={styles.button} onPress={() => void onSignInPress()}>
        <Text style={styles.buttonText}>Continue with Google</Text>
      </Pressable>
      {e2e ? (
        <Pressable
          style={styles.probeButton}
          onPress={() => void onProbePress()}
        >
          <Text style={styles.buttonText}>Run redirect probe</Text>
        </Pressable>
      ) : null}
      {status ? <Text style={styles.status}>{status}</Text> : null}
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
  status: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
});
