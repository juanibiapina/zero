import { useAuth } from '@clerk/expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { fetchTodoAuthority } from './api';
import { useTaskDOFixtureTasks } from './taskdo-tasks-api';

type Fixture = ReturnType<typeof useTaskDOFixtureTasks>;
const FixtureContext = createContext<Fixture | null>(null);

export function TaskDOFixtureProvider({ children }: { children: ReactNode }) {
  const fixture = useTaskDOFixtureTasks();
  // Do not render an empty fixture as an empty account while the local file is
  // opening or failed. All signed-in screens share this single ready gate.
  if (!fixture.ready) return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant={fixture.error ? 'error' : 'subtitle'}>
        {fixture.error ?? 'Opening your saved tasks…'}
      </Text>
    </View>
  );
  return <FixtureContext.Provider value={fixture}>{children}</FixtureContext.Provider>;
}

export function TodoDataProvider({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);
  const [authority, setAuthority] = useState<'legacy' | 'frozen' | 'switched' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const key = `todo-authority:${userId ?? 'unknown'}`;
    void (async () => {
      const stored = await AsyncStorage.getItem(key);
      const cached = stored === 'legacy' || stored === 'switched' ? stored : null;
      if (live && cached) setAuthority(cached);
      try {
        const next = await fetchTodoAuthority(() => getTokenRef.current());
        if (next !== 'frozen') await AsyncStorage.setItem(key, next);
        if (live) {
          setAuthority(next);
          setError(null);
        }
      } catch (cause) {
        if (live && !cached) setError(String(cause));
      }
    })();
    return () => { live = false; };
  }, [userId]);
  if (error || authority === 'frozen') return (
    <View className="flex-1 items-center justify-center bg-background px-screen-x">
      <Text variant={error ? 'error' : 'subtitle'} className="text-center">
        {error ?? 'Todo maintenance is in progress. Your saved work is unchanged.'}
      </Text>
    </View>
  );
  if (authority === null) return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant="subtitle">Opening your saved tasks…</Text>
    </View>
  );
  return authority === 'switched'
    ? <TaskDOFixtureProvider>{children}</TaskDOFixtureProvider>
    : children;
}

export function useTaskDOFixtureContext() {
  return useContext(FixtureContext);
}
