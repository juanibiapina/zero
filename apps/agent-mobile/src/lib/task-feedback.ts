import { localToday, toast, type Project } from '@zero/agent-core';
import { router } from 'expo-router';

export function showTaskDestination(
  task: { showUpDate: string | null; projectId: string | null },
  projects: Project[],
  action: 'moved' | 'created',
) {
  const today = localToday();
  const project = projects.find((p) => p.id === task.projectId);
  const future = task.showUpDate != null && task.showUpDate > today;
  const destination = future ? '/upcoming' : task.projectId ? `/projects/${task.projectId}` : '/';
  const message = action === 'moved'
    ? (task.projectId ? 'Moved to project' : 'Removed from project')
    : 'Filed to project';
  toast(message, {
    id: 'task-destination',
    description: future ? 'Upcoming' : project ? `${project.icon} ${project.title}` : task.projectId ? undefined : 'Home',
    action: {
      label: 'View',
      onPress: () => task.projectId && !future
        ? router.navigate(`/projects/${task.projectId}`, { withAnchor: true })
        : router.navigate(destination as '/' | '/upcoming'),
    },
  });
}
