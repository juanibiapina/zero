import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  homeTasks,
  type ProjectsApi,
  type TasksApi,
} from '@zero/agent-core';
import { useEffect } from 'react';

import {
  homeAppIconForTaskCount,
  syncHomeAppIcon,
} from '@/lib/home-app-icon';
import { useLocalDay } from '@/lib/local-day';
import { useProjectsApi, useTasksApi } from '@/lib/todo-api-hooks';

// Keep Android's launcher icon equal to the list Home actually shows. This
// module owns collection hydration, Home's shared visibility rule, icon
// bucketing, and the native side effect behind one render-nothing interface.
export function HomeAppIconSync() {
  const tasksApi = useTasksApi();
  const projectsApi = useProjectsApi();
  if (!tasksApi || !projectsApi) return null;

  return (
    <HydratedHomeAppIconSync
      tasksApi={tasksApi}
      projectsApi={projectsApi}
    />
  );
}

function HydratedHomeAppIconSync({
  tasksApi,
  projectsApi,
}: {
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
}) {
  const { data: tasks, isLoading: tasksLoading } = useLiveQuery((q) =>
    q
      .from({ task: tasksApi.collection })
      .where(({ task }) => isNull(task.completedAt)),
  );
  const { data: projects, isLoading: projectsLoading } = useLiveQuery((q) =>
    q.from({ project: projectsApi.collection }),
  );
  const today = useLocalDay();

  const hydrated = !tasksLoading && !projectsLoading;
  const icon = hydrated
    ? homeAppIconForTaskCount(
        homeTasks(tasks ?? [], projects ?? [], today).length,
      )
    : undefined;

  useEffect(() => {
    if (icon === undefined) return;
    void syncHomeAppIcon(icon);
  }, [icon]);

  return null;
}
