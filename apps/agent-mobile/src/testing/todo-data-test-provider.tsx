import type { ReactNode } from 'react';

import { TodoDataContextProvider } from '@/lib/todo-data-context';
import { useRestProjectsApiForTest } from '@/lib/projects-collection';
import { useRestTasksApiForTest } from '@/lib/tasks-collection';
import { useRestWaitsApiForTest } from '@/lib/waits-collection';

export function TodoDataTestProvider({ children }: { children: ReactNode }) {
  const api = useRestTasksApiForTest();
  const projectsApi = useRestProjectsApiForTest();
  const waitsApi = useRestWaitsApiForTest();
  if (!api || !projectsApi || !waitsApi) return null;
  return (
    <TodoDataContextProvider value={{
      api,
      projectsApi,
      waitsApi,
      ready: true,
      connected: true,
      error: null,
      recoveries: [],
      repair: async () => {},
    }}>
      {children}
    </TodoDataContextProvider>
  );
}
