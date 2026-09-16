import { Column, ListItem, Text as UIText } from '@expo/ui';
import {
  candidateAfterProjects,
  messageOf,
  type Project,
  type ProjectsApi,
  type TasksApi,
  type WaitsApi,
} from '@zero/agent-core';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useQuickAdd } from '@/components/quick-add-composer';
import { ProjectPickerSheet } from '@/components/task-detail';
import { Fab } from '@/components/ui/fab';
import { Sheet } from '@/components/ui/sheet';
import { WaitingComposer } from '@/components/waiting-composer';
import type { TokenGetter } from '@/lib/api';
import { useColor } from '@/lib/theme';

export type ProjectAddController = {
  bar: ReactNode;
  openTask: () => void;
  openWaiting: () => void;
  openAfter: () => void;
  handleBack: () => boolean;
  active: boolean;
};

export function useProjectAdd({
  project,
  projectId,
  projects,
  conditions,
  tasksApi,
  projectsApi,
  waitsApi,
  getToken,
  onError,
}: {
  project: Project | null;
  projectId: string;
  projects: Project[];
  conditions: Parameters<typeof candidateAfterProjects>[2];
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
  getToken: TokenGetter;
  onError: (message: string | null) => void;
}): ProjectAddController {
  const [menuOpen, setMenuOpen] = useState(false);
  const [waitingOpen, setWaitingOpen] = useState(false);
  const [afterOpen, setAfterOpen] = useState(false);
  const foreground = useColor('--color-foreground');

  const task = useQuickAdd({
    tasksApi,
    projectsApi,
    projects,
    modes: ['task'],
    projectId,
    getToken,
    onError,
    fabLabel: 'Add task',
    showFab: false,
  });
  const independentProject = useQuickAdd({
    tasksApi,
    projectsApi,
    projects,
    modes: ['project'],
    getToken,
    onError,
    fabLabel: 'Add project',
    showFab: false,
  });
  const candidates = useMemo(
    () => candidateAfterProjects(projectId, projects, conditions),
    [projectId, projects, conditions],
  );

  const openChild = useCallback((open: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(open);
  }, []);
  const openTask = useCallback(() => openChild(task.open), [openChild, task.open]);
  const openWaiting = useCallback(
    () => openChild(() => setWaitingOpen(true)),
    [openChild],
  );
  const openAfter = useCallback(
    () => openChild(() => setAfterOpen(true)),
    [openChild],
  );
  const openProject = useCallback(
    () => openChild(independentProject.open),
    [independentProject.open, openChild],
  );

  const handleBack = useCallback(() => {
    if (afterOpen) {
      setAfterOpen(false);
      return true;
    }
    if (waitingOpen) {
      setWaitingOpen(false);
      return true;
    }
    if (task.handleBack()) return true;
    if (independentProject.handleBack()) return true;
    if (menuOpen) {
      setMenuOpen(false);
      return true;
    }
    return false;
  }, [afterOpen, waitingOpen, task, independentProject, menuOpen]);

  const bar = (
    <>
      {project && !menuOpen && !task.active && !independentProject.active && !waitingOpen && !afterOpen ? (
        <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 items-end px-screen-x pb-6">
          <Fab label="Add" onPress={() => setMenuOpen(true)} />
        </View>
      ) : null}

      <Sheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        contentPadding={{ top: 8, bottom: 16, left: 0, right: 0 }}
      >
        <Column>
          <Column style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 8 }}>
            <UIText textStyle={{ color: foreground, fontSize: 20, fontWeight: '600' }}>
              {`Add to ${project?.title ?? 'Project'}`}
            </UIText>
          </Column>
          <ListItem onPress={openTask}><UIText textStyle={{ color: foreground, fontSize: 16 }}>Task</UIText></ListItem>
          <ListItem onPress={openWaiting}><UIText textStyle={{ color: foreground, fontSize: 16 }}>Waiting condition</UIText></ListItem>
          <ListItem onPress={openAfter}><UIText textStyle={{ color: foreground, fontSize: 16 }}>After project</UIText></ListItem>
          <ListItem onPress={openProject}><UIText textStyle={{ color: foreground, fontSize: 16 }}>Project</UIText></ListItem>
        </Column>
      </Sheet>

      {task.bar}
      {independentProject.bar}

      <WaitingComposer
        open={waitingOpen}
        onClose={() => setWaitingOpen(false)}
        onAdd={(text) => {
          const tx = waitsApi.addWaiting(projectId, text);
          tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
          setWaitingOpen(false);
        }}
      />

      <ProjectPickerSheet
        open={afterOpen}
        title="After project"
        projects={candidates}
        selectedProjectId={null}
        showNoProject={false}
        emptyCopy="No available projects"
        onPick={(afterProjectId) => {
          if (afterProjectId) {
            const tx = waitsApi.addAfter(projectId, afterProjectId);
            tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
          }
          setAfterOpen(false);
        }}
        onClose={() => setAfterOpen(false)}
      />
    </>
  );

  return {
    bar,
    openTask,
    openWaiting,
    openAfter,
    handleBack,
    active:
      menuOpen || waitingOpen || afterOpen || task.active || independentProject.active,
  };
}
