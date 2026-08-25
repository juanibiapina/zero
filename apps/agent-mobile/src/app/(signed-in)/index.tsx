import { useAuth } from '@clerk/clerk-expo';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { addTodo, fetchTodos, type Todo } from '@/lib/api';

export default function HomeScreen() {
  const { getToken, signOut } = useAuth();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      }
    })();
    return () => {
      active = false;
    };
  }, [getToken]);

  const onAdd = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const todo = await addTodo(getToken, trimmed);
      setTodos((prev) => [...prev, todo]);
      setText('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [text, busy, getToken]);

  return (
    <View className="flex-1 gap-4 px-6 pt-16">
      <View className="flex-row items-center justify-between">
        <Text variant="title">Todos</Text>
        <Button
          variant="secondary"
          label="Sign out"
          onPress={() => void signOut()}
        />
      </View>

      <View className="flex-row gap-2">
        <Input
          className="flex-1"
          placeholder="Add a todo"
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => void onAdd()}
          returnKeyType="done"
        />
        <Button label="Add" disabled={busy} onPress={() => void onAdd()} />
      </View>

      {error ? <Text variant="error">{error}</Text> : null}

      <ScrollView className="flex-1">
        {todos.length === 0 ? (
          <Text variant="subtitle">No todos yet. Add one above.</Text>
        ) : (
          todos.map((item) => (
            <View key={item.id} className="border-b border-neutral-200 py-3">
              <Text>{item.text}</Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
