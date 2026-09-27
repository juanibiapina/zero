import {
  createInMemoryTaskdoClientState,
  type InMemoryTodoSeed,
} from '@zero/agent-core';
import type { ReactNode } from 'react';

import { TodoDataContextProvider, type TodoData } from '@/lib/todo-data-context';

export type { InMemoryTodoSeed };

export function createInMemoryTodoData(seed: InMemoryTodoSeed = {}): TodoData {
  return {
    ...createInMemoryTaskdoClientState(seed).state,
    workspaceStatus: 'account',
    signedIn: true,
    signOut: async () => {},
    discardLocalCopyAndSignOut: async () => {},
  };
}

export function InMemoryTodoDataProvider({
  children,
  data,
}: {
  children: ReactNode;
  data: TodoData;
}) {
  return <TodoDataContextProvider value={data}>{children}</TodoDataContextProvider>;
}
