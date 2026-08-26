import { useAuth } from '@clerk/expo';
import { UserButton } from '@clerk/expo/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
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
import { type Todo } from '@/lib/api';
import { useAddTodo, useMarkTodoDone, useTodos } from '@/lib/todos';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function HomeScreen() {
  const { getToken } = useAuth();

  // Server state via React Query: retry/backoff, refetch-on-reconnect and
  // refetch-on-focus (AppState) come from the QueryClient; the resume-time
  // "stuck error" is handled there, not by hand.
  const todosQuery = useTodos(getToken);
  const addMutation = useAddTodo(getToken);
  const doneMutation = useMarkTodoDone(getToken);

  const todos = todosQuery.data ?? [];
  const loading = todosQuery.isPending;
  const busy = addMutation.isPending;
  // A mutation the user just triggered wins; otherwise show a load error only
  // when there's nothing on screen, so a failed background refetch stays silent
  // behind the last-good list.
  const error = addMutation.error
    ? messageOf(addMutation.error)
    : doneMutation.error
      ? messageOf(doneMutation.error)
      : todos.length === 0 && todosQuery.error
        ? messageOf(todosQuery.error)
        : null;

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
    if (addMutation.isPending) return;
    // Keep the bar open and cleared for rapid, repeated capture.
    addMutation.mutate(trimmed, { onSuccess: () => setText('') });
  }, [text, addMutation]);

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

  const onDone = useCallback(
    (item: Todo) => {
      // Optimistic remove + rollback live in the mutation hook.
      doneMutation.mutate(item.id);
    },
    [doneMutation],
  );

  return (
    <View className="flex-1 px-6 pt-16">
      <View className="mb-4 flex-row items-center justify-between">
        <Text variant="title">Todos</Text>
        {/* Native Clerk avatar (already a 36px circle); tapping opens the
            profile (manage account, security, sign out). No wrapper clip — an
            extra rounded-full/overflow-hidden mask crops the avatar off-center. */}
        <UserButton />
      </View>

      {error ? <Text variant="error">{error}</Text> : null}

      <ScrollView className="flex-1">
        {loading ? (
          <Text variant="subtitle">Loading your todos…</Text>
        ) : todos.length === 0 ? (
          <Text variant="subtitle">No todos yet. Add one above.</Text>
        ) : (
          todos.map((item) => (
            // Animated row: marking done fades + collapses it out (exiting) and
            // the rows below slide up (layout); an error re-insert fades back in
            // (entering). onDone keeps its optimistic-remove contract.
            <Animated.View
              key={item.id}
              entering={FadeIn.duration(150)}
              exiting={FadeOut.duration(200)}
              layout={LinearTransition.duration(200)}
              className="flex-row items-center gap-3 border-b border-neutral-200 py-3"
            >
              {/* Leftside done control: a tappable circle, matching the
                  Person-avatar motif. Tap completes the item. */}
              <Pressable
                accessibilityLabel={`Mark "${item.text}" done`}
                className="h-6 w-6 rounded-full border-2 border-neutral-400"
                hitSlop={8}
                onPress={() => void onDone(item)}
              />
              <Text className="flex-1">{item.text}</Text>
            </Animated.View>
          ))
        )}
      </ScrollView>

      {/* Transition layer: cross-fades the plus FAB and the quick-add bar and
          lifts the bar with the keyboard. It owns the motion; this screen owns
          the state. */}
      <QuickAdd
        open={adding}
        text={text}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={() => void onAdd()}
        onRequestClose={requestClose}
        busy={busy}
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
    </View>
  );
}
