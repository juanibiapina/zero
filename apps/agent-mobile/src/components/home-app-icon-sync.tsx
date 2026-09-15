import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  homeTasks,
  type ProjectsApi,
  type TasksApi,
  type WaitsApi,
} from '@zero/agent-core';
import { useEffect } from 'react';

import {
  homeAppIconForTaskCount,
  syncHomeAppIcon,
} from '@/lib/home-app-icon';
import { useLocalDay } from '@/lib/local-day';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useWaitsApi } from '@/lib/waits-collection';

// Keep Android's launcher icon equal to the list Home actually shows. This
// module owns collection hydration, Home's shared visibility rule, icon
// bucketing, and the native side effect behind one render-nothing interface.
export function HomeAppIconSync() {
  const tasksApi = useTasksApi();
  const projectsApi = useProjectsApi();
  const waitsApi = useWaitsApi();

  if (!tasksApi || !projectsApi || !waitsApi) return null;

  return (
    <HydratedHomeAppIconSync
      tasksApi={tasksApi}
      projectsApi={projectsApi}
      waitsApi={waitsApi}
    />
  );
}

function HydratedHomeAppIconSync({
  tasksApi,
  projectsApi,
  waitsApi,
}: {
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
}) {
  const { data: tasks, isLoading: tasksLoading } = useLiveQuery((q) =>
    q
      .from({ task: tasksApi.collection })
      .where(({ task }) => isNull(task.completedAt)),
  );
  const { data: projects, isLoading: projectsLoading } = useLiveQuery((q) =>
    q.from({ project: projectsApi.collection }),
  );
  const { data: conditions, isLoading: conditionsLoading } = useLiveQuery((q) =>
    q.from({ condition: waitsApi.collection }),
  );
  const today = useLocalDay();

  const hydrated = !tasksLoading && !projectsLoading && !conditionsLoading;
  const icon = hydrated
    ? homeAppIconForTaskCount(
        homeTasks(
          tasks ?? [],
          projects ?? [],
          today,
          conditions ?? [],
        ).length,
      )
    : undefined;

  useEffect(() => {
    if (icon === undefined) return;
    void syncHomeAppIcon(icon);
  }, [icon]);

  return null;
}
