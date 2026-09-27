import { createContext, useContext, type ReactNode } from 'react';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useTodoData, type TodoData } from './use-todo-data';

export type { TodoData };

const TodoDataContext = createContext<TodoData | null>(null);

export function TodoDataContextProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: TodoData;
}) {
  return <TodoDataContext.Provider value={value}>{children}</TodoDataContext.Provider>;
}

export function TodoDataProvider({ children }: { children: ReactNode }) {
  const data = useTodoData();
  if (!data.ready && data.workspaceStatus === 'locked') {
    return <LockedWorkspace message={data.error} />;
  }
  // A failed final sign-out step keeps the account surface mounted so the user
  // can retry, but its already-closed replica is never exposed as guest data.
  if (!data.ready && data.workspaceStatus !== 'signing-out') return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant={data.error ? 'error' : 'subtitle'}>
        {data.error ?? 'Opening your saved tasks…'}
      </Text>
    </View>
  );
  return <TodoDataContextProvider value={data}>{children}</TodoDataContextProvider>;
}

function LockedWorkspace({ message }: { message: string | null }) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background">
      <View
        className="mb-2 flex-row items-center justify-between px-screen-x"
        style={{ paddingTop: insets.top + 12 }}
      >
        <Text variant="title">Home</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Account"
          hitSlop={8}
          onPress={() => router.push('/sign-in')}
          className="h-10 w-10 items-center justify-center rounded-full bg-surface-muted"
        >
          <Text className="text-[20px]">👤</Text>
        </Pressable>
      </View>
      <Text variant="error" className="px-screen-x">
        {message ?? 'Sign in again to unlock your saved tasks.'}
      </Text>
    </View>
  );
}

export function useTodoDataContext() {
  return useContext(TodoDataContext);
}
