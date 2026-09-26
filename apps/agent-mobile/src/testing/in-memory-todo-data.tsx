import { createCollection, localOnlyCollectionOptions } from '@tanstack/db';
import type { Project, ProjectAttention, Task } from '@zero/agent-core';
import type { ReactNode } from 'react';

import { TodoDataContextProvider, type TodoData } from '@/lib/todo-data-context';
import { createTodoApis } from '@/lib/todo-apis';

export type InMemoryTodoSeed = {
  tasks?: Task[];
  projects?: Project[];
  waits?: ProjectAttention[];
};

export function createInMemoryTodoData(seed: InMemoryTodoSeed = {}): TodoData {
  const tasks = createCollection(localOnlyCollectionOptions<Task, string>({
    getKey: (task) => task.id,
    initialData: seed.tasks ?? [],
  }));
  const projects = createCollection(localOnlyCollectionOptions<Project, string>({
    getKey: (project) => project.id,
    initialData: seed.projects ?? [],
  }));
  const waits = createCollection(localOnlyCollectionOptions<ProjectAttention, string>({
    getKey: (condition) => condition.id,
    initialData: seed.waits ?? [],
  }));

  return {
    ...createTodoApis({ tasks, projects, waits }),
    ready: true,
    connected: true,
    error: null,
    recoveries: [],
    repair: async () => {},
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
