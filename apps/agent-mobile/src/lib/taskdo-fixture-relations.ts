import { useAuth } from '@clerk/expo';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useQueryClient } from '@tanstack/react-query';
import type { Project, ProjectAttention, ProjectsApi, WaitsApi } from '@zero/agent-core';
import { useMemo } from 'react';

const unsupported = (): never => {
  throw new Error('Project and Waiting writes are not available in this fixture');
};
const noError = () => null;
const noErrorSubscription = () => () => {};
const noRefetch = async () => {};

export function useTaskDOFixtureRelations(): { projectsApi: ProjectsApi; waitsApi: WaitsApi } {
  const { userId } = useAuth();
  const queryClient = useQueryClient();
  return useMemo(() => {
    const projects = createCollection(queryCollectionOptions({
      queryClient,
      queryKey: ['taskdo-fixture-projects', userId],
      queryFn: async (): Promise<Project[]> => [],
      getKey: (project: Project) => project.id,
    }));
    const waits = createCollection(queryCollectionOptions({
      queryClient,
      queryKey: ['taskdo-fixture-waits', userId],
      queryFn: async (): Promise<ProjectAttention[]> => [],
      getKey: (condition: ProjectAttention) => condition.id,
    }));
    return {
      projectsApi: {
        collection: projects,
        add: unsupported, setState: unsupported, reopen: unsupported,
        edit: unsupported, remove: unsupported,
        offline: false, refetch: noRefetch,
        getLoadError: noError, subscribeLoadError: noErrorSubscription,
      },
      waitsApi: {
        collection: waits,
        addWaiting: unsupported, addAfter: unsupported,
        resolveWaiting: unsupported, remove: unsupported,
        offline: false, refetch: noRefetch,
        getLoadError: noError, subscribeLoadError: noErrorSubscription,
      },
    };
  }, [queryClient, userId]);
}
