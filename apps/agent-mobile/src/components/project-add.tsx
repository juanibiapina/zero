import {
  type AddMode,
  type Project,
  type ProjectsApi,
  type TasksApi,
  type WaitingCondition,
  type WaitsApi,
} from '@zero/agent-core';
import { useCallback, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useQuickAdd } from '@/components/quick-add-composer';
import { Fab } from '@/components/ui/fab';
import type { TokenGetter } from '@/lib/api';

const PROJECT_ADD_MODES: AddMode[] = [
  'task',
  'waiting',
  'after',
  'project',
];

export type ProjectAddController = {
  bar: ReactNode;
  openFor: (project: Project, initialMode?: AddMode) => void;
  openTask: () => void;
  openWaiting: () => void;
  openAfter: () => void;
  handleBack: () => boolean;
  active: boolean;
};

// Project-context creation has one owner. A Project screen supplies its default
// destination and gets a FAB plus local-section shortcuts. Home and Upcoming
// omit the default and open the same drawer from Task-completion feedback.
export function useProjectAdd({
  project,
  projects,
  conditions,
  tasksApi,
  projectsApi,
  waitsApi,
  getToken,
  onError,
  showFab = true,
}: {
  project: Project | null;
  projects: Project[];
  conditions: WaitingCondition[];
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
  getToken: TokenGetter;
  onError: (message: string | null) => void;
  showFab?: boolean;
}): ProjectAddController {
  const [destination, setDestination] = useState<Project | null>(project);
  const activeProject =
    destination && project && destination.id === project.id
      ? project
      : destination;
  const resetDestination = useCallback(
    () => setDestination(project),
    [project],
  );

  const add = useQuickAdd({
    tasksApi,
    projectsApi,
    projects,
    modes: PROJECT_ADD_MODES,
    scope: {
      kind: 'project',
      project: activeProject,
      conditions,
      waitsApi,
    },
    getToken,
    onError,
    fabLabel: 'Add',
    showFab: false,
    onClosed: resetDestination,
  });
  const openAdd = add.open;

  const openFor = useCallback(
    (nextProject: Project, initialMode: AddMode = 'task') => {
      setDestination(nextProject);
      openAdd({ initialMode, projectId: nextProject.id });
    },
    [openAdd],
  );
  const openDefault = useCallback(
    (initialMode: AddMode) => {
      if (project) openFor(project, initialMode);
    },
    [project, openFor],
  );
  const openTask = useCallback(() => openDefault('task'), [openDefault]);
  const openWaiting = useCallback(
    () => openDefault('waiting'),
    [openDefault],
  );
  const openAfter = useCallback(() => openDefault('after'), [openDefault]);

  const bar = (
    <>
      {showFab && project && !add.active ? (
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 bottom-0 items-end px-screen-x pb-6"
        >
          <Fab label="Add" onPress={openTask} />
        </View>
      ) : null}
      {add.bar}
    </>
  );

  return {
    bar,
    openFor,
    openTask,
    openWaiting,
    openAfter,
    handleBack: add.handleBack,
    active: add.active,
  };
}
