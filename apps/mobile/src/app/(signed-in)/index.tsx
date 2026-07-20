import { useAuth } from '@clerk/clerk-expo';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchUserSettings, type UserSettings } from '@/lib/api';

export default function HomeScreen() {
  const { getToken, signOut } = useAuth();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchUserSettings(getToken);
        if (!cancelled) setSettings(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Zero Agent</Text>
      {settings ? (
        <Text style={styles.status}>
          Signed in. Onboarding {settings.onboardingSeen ? 'done' : 'pending'}.
        </Text>
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <Text style={styles.status}>Loading your account…</Text>
      )}
      <Pressable style={styles.button} onPress={() => void signOut()}>
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
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
  status: {
    fontSize: 16,
    color: '#444',
  },
  error: {
    fontSize: 14,
    color: '#b00020',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#eee',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '500',
  },
});
