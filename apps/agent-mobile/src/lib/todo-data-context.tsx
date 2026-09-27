import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';

import { WorkspaceAccountRecovery } from '@/components/workspace-account-recovery';
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
  if (
    !data.ready
    && (data.workspaceStatus === 'locked' || data.workspaceStatus === 'mismatch')
  ) {
    return <WorkspaceAccountRecovery data={data} />;
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

export function useTodoDataContext() {
  return useContext(TodoDataContext);
}
