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
import {
  KeyboardEvents,
  KeyboardStickyView,
} from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
} from 'react-native-reanimated';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Fab } from '@/components/ui/fab';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { addTodo, fetchTodos, markTodoDone, type Todo } from '@/lib/api';

export default function HomeScreen() {
  const { getToken } = useAuth();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await fetchTodos(getToken);
        if (active) {
          setTodos(list);
          setError(null);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [getToken]);

  const onAdd = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Submitting an empty input closes the quick-add bar.
      setAdding(false);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const todo = await addTodo(getToken, trimmed);
      setTodos((prev) => [...prev, todo]);
      setText('');
      setError(null);
      // Keep the bar open and cleared for rapid, repeated capture.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [text, busy, getToken]);

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
    async (item: Todo) => {
      // Optimistic: drop it now, restore on failure.
      setTodos((prev) => prev.filter((t) => t.id !== item.id));
      try {
        await markTodoDone(getToken, item.id);
        setError(null);
      } catch (err) {
        setTodos((prev) => [...prev, item]);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [getToken],
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

      {adding ? (
        <>
          {/* Backdrop: tap outside the bar to dismiss. */}
          <Pressable
            accessibilityLabel="Dismiss quick add"
            className="absolute inset-0"
            onPress={requestClose}
          />
          <KeyboardStickyView className="absolute inset-x-0 bottom-0">
            <View className="flex-row gap-2 border-t border-neutral-200 bg-white px-6 py-3">
              <Input
                ref={inputRef}
                className="flex-1"
                placeholder="Add a todo"
                value={text}
                onChangeText={setText}
                onSubmitEditing={() => void onAdd()}
                blurOnSubmit={false}
                returnKeyType="done"
                autoFocus
              />
              <Fab
                label="Add todo"
                className="h-12 w-12"
                disabled={busy}
                onPress={() => void onAdd()}
              />
            </View>
          </KeyboardStickyView>
          {confirmingDiscard ? (
            <ConfirmDialog
              title="Discard changes?"
              message="The changes you've made will not be saved."
              cancelLabel="Cancel"
              confirmLabel="Discard"
              destructive
              onCancel={() => {
                setConfirmingDiscard(false);
                // The Back that opened this dialog also hid the keyboard;
                // refocus to bring it back so editing continues seamlessly.
                inputRef.current?.focus();
              }}
              onConfirm={closeAdd}
            />
          ) : null}
        </>
      ) : (
        <Fab
          label="Add todo"
          className="absolute bottom-6 right-6"
          onPress={() => setAdding(true)}
        />
      )}
    </View>
  );
}
