import { useAuth } from '@clerk/expo';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { RUNTIME_PROFILE } from '@/lib/runtime-profile';
import { resetHermeticTodoState } from '@/lib/hermetic-state-reset';

export default function HermeticResetScreen() {
  const { signOut } = useAuth();
  const [status, setStatus] = useState<'resetting' | 'done' | 'failed'>('resetting');

  useEffect(() => {
    if (!RUNTIME_PROFILE.hermetic) return;
    void (async () => {
      try {
        await signOut();
        await resetHermeticTodoState();
        setStatus('done');
      } catch {
        setStatus('failed');
      }
    })();
  }, [signOut]);

  if (!RUNTIME_PROFILE.hermetic) return <Redirect href="/" />;
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-background px-6">
      {status === 'resetting' ? <ActivityIndicator /> : null}
      <Text>{status === 'done'
        ? 'Hermetic state reset'
        : status === 'failed' ? 'Hermetic state reset failed' : 'Resetting hermetic state'}</Text>
    </View>
  );
}
