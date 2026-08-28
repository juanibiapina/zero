import { useAuth } from '@clerk/expo';
import { UserButton } from '@clerk/expo/native';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useQueryClient } from '@tanstack/react-query';
import {
  CAPTURES_QUERY_KEY,
  inboxView,
  type Capture,
  type CapturesApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  type ListRenderItemInfo,
  Pressable,
  type TextInput,
  View,
} from 'react-native';
import { KeyboardEvents } from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
} from 'react-native-reanimated';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { QuickAdd } from '@/components/quick-add';
import { Text } from '@/components/ui/text';
import { createMobileCapturesApi } from '@/lib/captures-collection';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const AnimatedFlatList = Animated.FlatList<Capture>;

// Build the Capture data layer once inside the signed-in tree, where the Clerk
// token getter is valid. getToken is read through a ref so the collection is
// built once (not rebuilt when Clerk hands back a new function identity).
function useCapturesApi(): CapturesApi | null {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const [api, setApi] = useState<CapturesApi | null>(null);
  useEffect(() => {
    let live = true;
    let built: CapturesApi | null = null;
    void createMobileCapturesApi({
      queryClient,
      getToken: () => getTokenRef.current(),
    }).then((a) => {
      built = a;
      if (live) {
        setApi(a);
      } else {
        // Unmounted before it resolved: release the collection's subscription.
        void a.collection.cleanup();
      }
    });
    return () => {
      live = false;
      if (built) void built.collection.cleanup();
    };
  }, [queryClient]);

  return api;
}

// Read the collection's read (sync) error from the shared QueryClient. useLiveQuery
// exposes isError but not the message, and the error lives in the react-query
// cache under CAPTURES_QUERY_KEY. Returns the message only while an error is the
// current state.
function useLoadError(): string | null {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      const state = queryClient.getQueryState(CAPTURES_QUERY_KEY);
      setError(
        state?.status === 'error' && state.error
          ? messageOf(state.error)
          : null,
      );
    };
    read();
    return queryClient.getQueryCache().subscribe(read);
  }, [queryClient]);
  return error;
}

export default function HomeScreen() {
  const api = useCapturesApi();
  return (
    <View className="flex-1 px-6 pt-16">
      <View className="mb-4 flex-row items-center justify-between">
        <Text variant="title">Inbox</Text>
        {/* No wrapper: a rounded-full/overflow-hidden mask crops the native
            avatar off-center. */}
        <UserButton />
      </View>

      {api ? (
        <Inbox api={api} />
      ) : (
        <Text variant="subtitle">Loading your inbox…</Text>
      )}
    </View>
  );
}

function Inbox({ api }: { api: CapturesApi }) {
  const { data: captures, isLoading } = useLiveQuery((q) =>
    q
      .from({ c: api.collection })
      .where(({ c }) => isNull(c.processedAt))
      .orderBy(({ c }) => c.createdAt, 'asc'),
  );
  const list = captures ?? [];

  const loadError = useLoadError();
  const [writeError, setWriteError] = useState<string | null>(null);
  // Gate the list on the row count, not isLoading: a hydrated snapshot must
  // paint even while the network sync is still pending, so opening the Inbox
  // never blinks to a spinner over stale rows.
  const view = inboxView({ count: list.length, isLoading, loadError });
  // Show a load error only when there's nothing on screen, so a failed
  // background refetch stays silent behind the last-good Inbox.
  const error = writeError ?? (list.length === 0 ? loadError : null);

  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Submitting an empty input closes the quick-add bar.
      setAdding(false);
      return;
    }
    setWriteError(null);
    // Optimistic: the row appears at once; surface a failure if the write loses.
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    // Keep the bar open and cleared for rapid, repeated capture.
    setText('');
  }, [text, api]);

  const closeAdd = useCallback(() => {
    setText('');
    setConfirmingDiscard(false);
    setAdding(false);
  }, []);

  // Dismissing the quick-add: with unsaved text, confirm before discarding;
  // with an empty input, close silently.
  const requestClose = useCallback(() => {
    if (text.trim()) {
      setConfirmingDiscard(true);
    } else {
      closeAdd();
    }
  }, [text, closeAdd]);

  // First Android Back press with the keyboard up is swallowed by the OS to
  // hide the keyboard and never reaches BackHandler. So treat "keyboard hidden
  // while the quick-add is open" as a dismiss request, giving the Todoist
  // single-back behavior: with unsaved text, confirm before discarding; with an
  // empty input, close the bar (previously it stayed open, needing a second
  // Back). Guard on `adding` (not confirming) so the hide that fires while
  // closing (input unmounts) doesn't re-trigger.
  useEffect(() => {
    const sub = KeyboardEvents.addListener('keyboardDidHide', () => {
      if (!adding || confirmingDiscard) return;
      if (text.trim()) {
        setConfirmingDiscard(true);
      } else {
        closeAdd();
      }
    });
    return () => sub.remove();
  }, [adding, confirmingDiscard, text, closeAdd]);

  // Android hardware / navigation back button, for the cases where the keyboard
  // is already down (dialog open, or bar open after the keyboard was hidden).
  // Returning true consumes the event so the OS does not navigate away.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (confirmingDiscard) {
        setConfirmingDiscard(false);
        return true;
      }
      if (adding && text.trim()) {
        setConfirmingDiscard(true);
        return true;
      }
      if (adding) {
        closeAdd();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [adding, confirmingDiscard, text, closeAdd]);

  const onProcess = useCallback(
    (item: Capture) => {
      setWriteError(null);
      const tx = api.process(item.id);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Capture>) => (
      <Animated.View
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(200)}
        className="flex-row items-center gap-3 border-b border-neutral-200 py-3"
      >
        <Pressable
          accessibilityLabel={`Process "${item.text}"`}
          className="h-6 w-6 rounded-full border-2 border-neutral-400"
          hitSlop={8}
          onPress={() => onProcess(item)}
        />
        <Text className="flex-1">{item.text}</Text>
      </Animated.View>
    ),
    [onProcess],
  );

  return (
    <>
      {error ? <Text variant="error">{error}</Text> : null}

      {view === 'loading' ? (
        <Text variant="subtitle">Loading your inbox…</Text>
      ) : (
        // FlatList virtualizes the Inbox (unbounded); @expo/ui List is native
        // but not virtualized, so it is the wrong tool here. itemLayoutAnimation
        // slides the remaining rows when one is processed; the row's own
        // entering/exiting fades it in and out.
        <AnimatedFlatList
          style={{ flex: 1 }}
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          itemLayoutAnimation={LinearTransition.duration(200)}
          ListEmptyComponent={
            <Text variant="subtitle">
              Your inbox is empty. Capture something.
            </Text>
          }
        />
      )}

      {/* Transition layer: cross-fades the plus FAB and the quick-add bar and
          lifts the bar with the keyboard. It owns the motion; this screen owns
          the state. */}
      <QuickAdd
        open={adding}
        text={text}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={() => onAdd()}
        onRequestClose={requestClose}
        busy={false}
        inputRef={inputRef}
      />

      {confirmingDiscard ? (
        <ConfirmDialog
          title="Discard changes?"
          message="The changes you've made will not be saved."
          cancelLabel="Cancel"
          confirmLabel="Discard"
          destructive
          onCancel={() => {
            setConfirmingDiscard(false);
            // The Back that opened this dialog also hid the keyboard; refocus to
            // bring it back so editing continues seamlessly.
            inputRef.current?.focus();
          }}
          onConfirm={closeAdd}
        />
      ) : null}
    </>
  );
}
