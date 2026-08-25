import { useAuth } from '@clerk/clerk-expo';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
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
    <View className="flex-1 items-center justify-center gap-4 px-6">
      <Text variant="title">Zero Agent</Text>
      {settings ? (
        <Text variant="subtitle">
          Signed in. Onboarding {settings.onboardingSeen ? 'done' : 'pending'}.
        </Text>
      ) : error ? (
        <Text variant="error">{error}</Text>
      ) : (
        <Text variant="subtitle">Loading your account…</Text>
      )}
      <Button
        variant="secondary"
        label="Sign out"
        onPress={() => void signOut()}
      />
    </View>
  );
}
