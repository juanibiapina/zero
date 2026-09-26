import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useTodoData, type TodoData } from './taskdo-tasks-api';

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
  // Do not render an empty replica as an empty account while its local file is
  // opening or failed. Every signed-in todo screen shares this ready gate.
  if (!data.ready) return (
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
