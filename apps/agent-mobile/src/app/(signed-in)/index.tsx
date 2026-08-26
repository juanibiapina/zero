import { useAuth } from '@clerk/expo';
import { UserButton } from '@clerk/expo/native';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';

import { Fab } from '@/components/ui/fab';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { addTodo, fetchTodos, type Todo } from '@/lib/api';

export default function HomeScreen() {
  const { getToken } = useAuth();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

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
    setAdding(false);
  }, []);

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
            <View key={item.id} className="border-b border-neutral-200 py-3">
              <Text>{item.text}</Text>
            </View>
          ))
        )}
      </ScrollView>

      {adding ? (
        <>
          {/* Backdrop: tap outside the bar to dismiss. */}
          <Pressable
            accessibilityLabel="Dismiss quick add"
            className="absolute inset-0"
            onPress={closeAdd}
          />
          <KeyboardStickyView className="absolute inset-x-0 bottom-0">
            <View className="flex-row gap-2 border-t border-neutral-200 bg-white px-6 py-3">
              <Input
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
