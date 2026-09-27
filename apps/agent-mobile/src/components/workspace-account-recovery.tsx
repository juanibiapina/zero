import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import type { TodoData } from '@/lib/use-todo-data';

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspaceAccountRecovery({ data }: { data: TodoData }) {
  const insets = useSafeAreaInsets();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = data.workspaceStatus === 'mismatch';

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirming(false);
    } catch (cause) {
      setError(messageOf(cause));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <View
        className="mb-2 flex-row items-center justify-between px-screen-x"
        style={{ paddingTop: insets.top + 12 }}
      >
        <Text variant="title">Home</Text>
        <View
          accessibilityLabel="Account"
          className="h-10 w-10 items-center justify-center rounded-full bg-surface-muted"
        >
          <Text className="text-[20px]">👤</Text>
        </View>
      </View>
      <View className="flex-1 justify-center gap-4 px-screen-x pb-16">
        <Text variant="title">
          {mismatch ? 'These tasks belong to another account' : 'Tasks locked'}
        </Text>
        {confirming ? (
          <>
            <Text className="font-semibold">Delete this device copy?</Text>
            <Text variant="subtitle">
              The saved tasks for the other account will be removed from this device. This account will then start with its own synced workspace.
            </Text>
            <View className="flex-row justify-end gap-5">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                disabled={busy}
                onPress={() => setConfirming(false)}
              >
                <Text className="font-semibold text-accent">Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete copy and continue"
                disabled={busy}
                onPress={() => void run(data.deleteLocalCopyAndContinue)}
              >
                <Text className="font-semibold text-danger">Delete copy and continue</Text>
              </Pressable>
            </View>
          </>
        ) : mismatch ? (
          <>
            <Text variant="subtitle">
              Sign out to keep this device copy and return with the original account, or delete it to continue with this account.
            </Text>
            {error ? <Text variant="error">{error}</Text> : null}
            {busy ? <ActivityIndicator accessibilityLabel="Updating account" /> : null}
            <View className="items-end gap-4">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sign out of this account"
                disabled={busy}
                onPress={() => void run(data.signOutWrongAccount)}
              >
                <Text className="font-semibold text-accent">Sign out of this account</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete local copy"
                disabled={busy}
                onPress={() => setConfirming(true)}
              >
                <Text className="font-semibold text-danger">Delete local copy</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text variant="subtitle">
              Sign in with the account for this device to unlock your tasks.
            </Text>
            {data.error ? <Text variant="error">{data.error}</Text> : null}
            <View className="items-end">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sign in"
                onPress={() => router.push('/sign-in')}
              >
                <Text className="font-semibold text-accent">Sign in</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </View>
  );
}
