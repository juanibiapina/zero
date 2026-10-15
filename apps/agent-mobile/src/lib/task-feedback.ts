import { localToday, toast, type Project } from '@zero/agent-core';
import { router } from 'expo-router';

export function showTaskDestination(
  task: { showUpDate: string | null; projectId: string },
  projects: Project[],
) {
  const today = localToday();
  const project = projects.find((p) => p.id === task.projectId);
  const future = task.showUpDate != null && task.showUpDate > today;
  toast('Filed to project', {
    id: 'task-destination',
    description: future ? 'Upcoming' : project ? `${project.icon} ${project.title}` : undefined,
    action: {
      label: 'View',
      onPress: () => future
        ? router.navigate('/browse/upcoming', { withAnchor: true })
        : router.navigate(`/projects/${task.projectId}`, { withAnchor: true }),
    },
  });
}
