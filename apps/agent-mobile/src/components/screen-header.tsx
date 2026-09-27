import { useUser } from '@clerk/expo';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useTodoDataContext } from '@/lib/todo-data-context';

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function AccountControl() {
  const data = useTodoDataContext();
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = data?.signedIn ?? false;
  const locked = data?.workspaceStatus === 'locked';
  const identity = user?.primaryEmailAddress?.emailAddress
    ?? user?.fullName
    ?? 'Signed in';

  const finishSignOut = async (discard: boolean) => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      if (discard) await data.discardLocalCopyAndSignOut();
      else await data.signOut();
      setOpen(false);
      setConfirming(false);
    } catch (cause) {
      setError(messageOf(cause));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Account"
        hitSlop={8}
        onPress={() => {
          setError(null);
          setConfirming(false);
          setOpen(true);
        }}
        className="h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-surface-muted"
      >
        {signedIn && user?.imageUrl ? (
          <Image source={user.imageUrl} style={{ width: 40, height: 40 }} />
        ) : (
          <Text className="text-[20px]">👤</Text>
        )}
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!busy) setOpen(false); }}
      >
        <View className="flex-1 items-center justify-center px-8">
          <Pressable
            accessibilityLabel="Close account"
            className="absolute inset-0 bg-scrim"
            onPress={() => { if (!busy) setOpen(false); }}
          />
          <View className="w-full max-w-sm gap-4 rounded-dialog bg-surface p-6 shadow-raised">
            <Text variant="title">{signedIn ? 'Account' : locked ? 'Tasks locked' : 'Your tasks'}</Text>
            {signedIn ? (
              <>
                <Text variant="subtitle">{identity}</Text>
                {confirming ? (
                  <>
                    <Text className="font-semibold">
                      Sign out and remove this device copy?
                    </Text>
                    <Text variant="subtitle">
                      Your synced tasks stay in your account. This device starts with an empty local workspace.
                    </Text>
                    <View className="flex-row justify-end gap-5">
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => setConfirming(false)}
                      >
                        <Text className="font-semibold text-accent">Cancel</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => void finishSignOut(false)}
                      >
                        <Text className="font-semibold text-danger">Remove copy and sign out</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <>
                    <Text variant="subtitle">
                      {data?.connected ? 'Synced' : 'Offline · saved on this device'}
                    </Text>
                    {error ? <Text variant="error">{error}</Text> : null}
                    {busy ? <ActivityIndicator accessibilityLabel="Signing out" /> : null}
                    <View className="items-end gap-4">
                      {error ? (
                        <>
                          <Pressable
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={() => void finishSignOut(false)}
                          >
                            <Text className="font-semibold text-accent">Retry sign out</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={() => void finishSignOut(true)}
                          >
                            <Text className="font-semibold text-danger">
                              Discard local copy and sign out
                            </Text>
                          </Pressable>
                        </>
                      ) : (
                        <Pressable
                          accessibilityRole="button"
                          disabled={busy}
                          onPress={() => setConfirming(true)}
                        >
                          <Text className="font-semibold text-danger">Sign out</Text>
                        </Pressable>
                      )}
                    </View>
                  </>
                )}
              </>
            ) : (
              <>
                {!locked ? <Text className="font-semibold">Saved on this device</Text> : null}
                <Text variant="subtitle">
                  {locked
                    ? 'Sign in with the account for this device to unlock your tasks.'
                    : 'Sign in to sync your tasks across devices.'}
                </Text>
                <View className="items-end">
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setOpen(false);
                      router.push('/sign-in');
                    }}
                  >
                    <Text className="font-semibold text-accent">Sign in</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

// Account actions stay app-owned so signing out can safely checkpoint and
// remove the local workspace before Clerk drops the session.
export function ScreenHeader({ title }: { title: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="mb-2 flex-row items-center justify-between px-screen-x"
      style={{ paddingTop: insets.top + 12 }}
    >
      <Text variant="title">{title}</Text>
      <AccountControl />
    </View>
  );
}
