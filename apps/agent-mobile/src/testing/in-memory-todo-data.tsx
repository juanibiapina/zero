import {
  createInMemoryTaskdoReplica,
  type InMemoryTodoSeed,
} from '@zero/agent-core';
import type { ReactNode } from 'react';

import { TodoDataContextProvider, type TodoData } from '@/lib/todo-data-context';

export type { InMemoryTodoSeed };

export function createInMemoryTodoData(seed: InMemoryTodoSeed = {}): TodoData {
  const replica = createInMemoryTaskdoReplica(seed);

  return {
    replica,
    ready: true,
    connected: true,
    durable: true,
    error: null,
    recoveries: replica.snapshot().recoveries,
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
