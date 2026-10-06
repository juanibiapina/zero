import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  homeTasks,
  type TaskdoReplica,
} from '@zero/agent-core';
import { useEffect } from 'react';

import { useLocalDay } from '@/lib/local-day';
import { useTodoReplica } from '@/lib/todo-replica-hook';
import { setHomeAppIcon, type HomeAppIcon } from '../../modules/home-app-icon';

// Keep Android's launcher icon equal to the list Home actually shows. This
// module owns collection hydration, Home's shared visibility rule, icon
// bucketing, and the native side effect behind one render-nothing interface.
export function HomeAppIconSync() {
  const replica = useTodoReplica();
  return replica ? <HydratedHomeAppIconSync replica={replica} /> : null;
}

function HydratedHomeAppIconSync({ replica }: { replica: TaskdoReplica }) {
  const { tasks: tasksApi, projects: projectsApi } = replica;
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
    ? iconForTaskCount(homeTasks(tasks ?? [], projects ?? [], today).length)
    : undefined;

  useEffect(() => {
    if (icon !== undefined) applyIcon(icon);
  }, [icon]);

  return null;
}

function iconForTaskCount(count: number): HomeAppIcon {
  if (count <= 0) return 'Empty';
  if (count === 1) return 'OneTask';
  if (count === 2) return 'TwoTasks';
  if (count === 3) return 'ThreeTasks';
  return 'FourPlusTasks';
}

const ICON_WARNING = 'Could not update the Home task-count launcher icon.';

function applyIcon(icon: HomeAppIcon) {
  try {
    if (!setHomeAppIcon(icon)) console.warn(ICON_WARNING);
  } catch (error) {
    console.warn(ICON_WARNING, error);
  }
}
