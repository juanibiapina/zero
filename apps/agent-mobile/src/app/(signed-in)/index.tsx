import { Button, Host } from '@expo/ui';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  listView,
  LOADING_TEXT_DELAY_MS,
  homeCallToAction,
  homeCallToActionCopy,
  homeTasks,
  taskIcon,
  type HomeCallToAction,
  type ProjectsApi,
  type Task,
  type TasksApi,
  type WaitsApi,
} from '@zero/agent-core';
import { useAuth } from '@clerk/expo';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, View } from 'react-native';

import { useTaskDOFixtureTasks } from '@/lib/taskdo-tasks-api';
import { useTaskDOFixtureRelations } from '@/lib/taskdo-fixture-relations';
import { RUNTIME_PROFILE } from '@/lib/runtime-profile';
import { useProjectAdd } from '@/components/project-add';
import { useQuickAdd } from '@/components/quick-add-composer';
import { ReorderableTaskList } from '@/components/reorderable-task-list';
import { ScreenHeader } from '@/components/screen-header';
import { useTaskDetail } from '@/components/task-detail';
import { Text } from '@/components/ui/text';
import { useLocalDay } from '@/lib/local-day';
import { useTasksApi } from '@/lib/tasks-collection';
import { useProjectsApi } from '@/lib/projects-collection';
import { useWaitsApi } from '@/lib/waits-collection';
import {
  useDelayed,
  useForegroundRefetch,
  useLoadError,
  usePullRefresh,
} from '@/lib/screen-hooks';

// The all-clear state on Home: shown only when the list is empty. The shared
// homeCallToAction seam picks the framing from the projects' derived states;
// every case routes to the Projects tab.
function HomeCallToActionView({ action }: { action: HomeCallToAction }) {
  const { title, body, button } = homeCallToActionCopy(action);
  return (
    <View className="flex-1 items-center justify-center gap-4 px-screen-x">
      <View className="items-center gap-1">
        <Text variant="title" className="text-center">
          {title}
        </Text>
        {body ? (
          <Text variant="subtitle" className="text-center">
            {body}
          </Text>
        ) : null}
      </View>
      <Host matchContents>
        <Button
          label={button}
          variant="filled"
          style={{ height: 48, borderRadius: 14, paddingHorizontal: 20 }}
          onPress={() => router.navigate('/projects')}
        />
      </Host>
    </View>
  );
}

// Home is one reorderable list of tasks: the loose ones you dropped in and the
// project tasks you have taken on (availability-gated by homeTasks). No separate
// capture inbox after the single-list merge. The quick-add defaults to a task
// and can switch to a project.
export default function HomeScreen() {
  if (RUNTIME_PROFILE.hermetic && process.env.EXPO_PUBLIC_TASKDO_PROOF === '1') {
    return <FixtureHomeScreen />;
  }
  return <LegacyHomeScreen />;
}

function FixtureHomeScreen() {
  const { userId } = useAuth();
  return <FixtureHomeForAccount key={userId ?? 'signed-out'} />;
}

function FixtureHomeForAccount() {
  const { api, error, connected } = useTaskDOFixtureTasks();
  const { projectsApi, waitsApi } = useTaskDOFixtureRelations();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Home" />
      {error ? <Text variant="error" className="px-screen-x">{error}</Text> : null}
      {api && projectsApi && waitsApi ? (
        <>
          <Text variant="subtitle" className="px-screen-x">
            {connected ? 'Synced' : 'Offline · saved on this device'}
          </Text>
          <Home api={api} projectsApi={projectsApi} waitsApi={waitsApi} fixture />
        </>
      ) : <View className="flex-1" />}
    </View>
  );
}

function LegacyHomeScreen() {
  const tasksApi = useTasksApi();
  const projectsApi = useProjectsApi();
  const waitsApi = useWaitsApi();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Home" />
      {tasksApi && projectsApi && waitsApi ? (
        <Home api={tasksApi} projectsApi={projectsApi} waitsApi={waitsApi} />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

function Home({
  api,
  projectsApi,
  waitsApi,
  fixture = false,
}: {
  api: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
  fixture?: boolean;
}) {
  const { getToken } = useAuth();
  const { data: tasks, isLoading } = useLiveQuery((q) =>
    q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: projects, isLoading: projectsLoading } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );

  const today = useLocalDay();
  // The single Home list: open ∧ shown-up ∧ available, ordered by the manual
  // sort key. The server returns all open tasks; this pass drops future-dated
  // ones (they belong to Upcoming) and unavailable project tasks.
  const list = useMemo(
    () => homeTasks(tasks ?? [], projects ?? [], today),
    [tasks, projects, today],
  );

  const cta = homeCallToAction(
    list.length,
    0,
    projects ?? [],
    tasks ?? [],
    today,
    conditions ?? [],
  );
  // Do not flash the CTA while the local snapshot hydrates (every collection
  // reads empty then, which would look like "create").
  const hydrating = isLoading || projectsLoading;

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  const refetchAll = useCallback(async () => {
    await Promise.all([api.refetch(), projectsApi.refetch(), waitsApi.refetch()]);
  }, [api, projectsApi, waitsApi]);
  useForegroundRefetch(refetchAll);
  const { refreshing, onRefresh } = usePullRefresh(refetchAll);
  const view = listView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);

  const projectAdd = useProjectAdd({
    project: null,
    projects: projects ?? [],
    conditions: conditions ?? [],
    openTasks: tasks ?? [],
    tasksApi: api,
    projectsApi,
    waitsApi,
    getToken,
    onError: setWriteError,
    showFab: false,
  });

  // The task detail editor delegates Project-scoped Waiting feedback to the
  // shared four-mode Project drawer mounted by this screen.
  const detail = useTaskDetail({
    api,
    list,
    projects: projects ?? [],
    openTasks: tasks ?? [],
    conditions: conditions ?? [],
    onAddWaiting: (project) => projectAdd.openFor(project, 'waiting'),
    onError: setWriteError,
    waitForPersist: fixture,
  });

  // A project task's icon (defaulting to the neutral one); a loose task has none.
  // The rule lives in the shared taskIcon resolver, so Home and Upcoming agree.
  const presentationOf = useCallback(
    (item: Task) => ({ icon: taskIcon(item, projects ?? []) }),
    [projects],
  );

  // The quick-add composer (drawer + date/project rows + picker sheets + discard
  // confirm + writes). Home offers task and project modes and the project row; the
  // shared hook owns everything else. See quick-add-composer.tsx.
  const add = useQuickAdd({
    tasksApi: api,
    projectsApi,
    projects: projects ?? [],
    openTasks: tasks ?? [],
    conditions: conditions ?? [],
    modes: fixture ? ['task'] : ['task', 'project'],
    scope: { kind: 'global' },
    getToken,
    onError: setWriteError,
    fabLabel: 'Task',
    waitForPersist: fixture,
  });

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail.handleBack()) {
        return true;
      }
      if (projectAdd.handleBack()) {
        return true;
      }
      if (add.handleBack()) {
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [detail, projectAdd, add]);

  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);

  return (
    <>
      {error ? (
        <Text variant="error" className="px-screen-x">
          {error}
        </Text>
      ) : null}

      {view === 'loading' ? (
        showLoadingText ? (
          <Text variant="subtitle" className="px-screen-x">
            Loading your tasks…
          </Text>
        ) : (
          <View className="flex-1" />
        )
      ) : (
        <ReorderableTaskList
          api={api}
          tasks={list}
          today={today}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onComplete={detail.complete}
          onOpen={detail.open}
          onError={setWriteError}
          presentationOf={presentationOf}
          swipeAction="postpone-tomorrow"
          empty={
            view === 'empty' && cta && !loadError ? (
              hydrating ? (
                <View className="flex-1" />
              ) : (
                <HomeCallToActionView action={cta} />
              )
            ) : null
          }
        />
      )}

      {detail.sheets}
      {projectAdd.bar}
      {add.bar}
    </>
  );
}
