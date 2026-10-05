import { Button, Host } from '@expo/ui';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  listView,
  LOADING_TEXT_DELAY_MS,
  homeTasks,
  projectStatusContext,
  projectStatusSections,
  taskIcon,
  todoSyncPresentation,
  type Project,
  type ProjectAttention,
  type ProjectDisplayStatus,
  type Task,
  type TaskdoReplica,
} from '@zero/agent-core';
import { useAuth } from '@clerk/expo';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BackHandler,
  Pressable,
  RefreshControl,
  SectionList,
  View,
} from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { useTodoDataContext } from '@/lib/todo-data-context';
import { useProjectAdd } from '@/components/project-add';
import { ProjectListRow } from '@/components/project-list-row';
import { useQuickAdd } from '@/components/quick-add-composer';
import { ReorderableTaskList } from '@/components/reorderable-task-list';
import { ScreenHeader } from '@/components/screen-header';
import { useTaskDetail } from '@/components/task-detail';
import { Text } from '@/components/ui/text';
import { useLocalDay } from '@/lib/local-day';
import { RUNTIME_PROFILE } from '@/lib/runtime-profile';
import { useColor } from '@/lib/theme';
import { useTodoReplica } from '@/lib/todo-replica-hook';
import {
  useDelayed,
  usePullRefresh,
} from '@/lib/screen-hooks';

type HomeProjectSection = {
  status: Extract<ProjectDisplayStatus, 'next' | 'waiting'>;
  title: 'Next' | 'Waiting';
  data: Project[];
};

function HomeClearState({
  projects,
  tasks,
  conditions,
  today,
  refreshing,
  onRefresh,
}: {
  projects: Project[];
  tasks: Task[];
  conditions: ProjectAttention[];
  today: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const accent = useColor('--color-accent');
  const ripple = useColor('--color-ripple');
  const allSections = useMemo(
    () => projectStatusSections({ projects, tasks, conditions, today }),
    [conditions, projects, tasks, today],
  );
  const currentProjectCount = useMemo(
    () => allSections.reduce((count, section) => count + section.count, 0),
    [allSections],
  );
  const sections = useMemo<HomeProjectSection[]>(
    () => allSections.flatMap((section) => {
      if (section.status !== 'next' && section.status !== 'waiting') return [];
      return [{
        status: section.status,
        title: section.status === 'next' ? 'Next' : 'Waiting',
        data: section.projects,
      }];
    }),
    [allSections],
  );
  const noCurrentProjects = currentProjectCount === 0;
  const neverHadProjects = projects.length === 0;

  const openProject = useCallback((project: Project) => {
    router.navigate(`/projects/${project.id}`, { withAnchor: true });
  }, []);

  return (
    <Animated.View
      entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
      style={{ flex: 1 }}
    >
      <SectionList
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 96 }}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={accent}
            colors={[accent]}
          />
        )}
        sections={sections}
        keyExtractor={(project) => project.id}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={(
          <View className="flex-row items-center gap-3 border-b border-divider px-screen-x py-6">
            <View
              accessible={false}
              importantForAccessibility="no-hide-descendants"
              className="h-10 w-10 items-center justify-center rounded-full bg-surface-muted"
            >
              <Text className="text-[24px] text-foreground-secondary">✓</Text>
            </View>
            <View className="flex-1 gap-0.5">
              <Text variant="section">Home is clear</Text>
              <Text variant="subtitle">Nothing needs your attention right now.</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={
          noCurrentProjects ? (
            <View className="gap-2 px-screen-x py-6">
              <Text variant="section">
                {neverHadProjects ? 'No projects yet' : 'No current projects'}
              </Text>
              <Text variant="subtitle">
                {neverHadProjects
                  ? 'Projects group related tasks around an outcome you want to accomplish.'
                  : 'Start another whenever you have a new outcome to work toward.'}
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          noCurrentProjects ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="View all projects"
              android_ripple={{ color: ripple }}
              className="min-h-12 justify-center px-screen-x py-3"
              onPress={() => router.navigate('/projects')}
            >
              <Text className="font-semibold text-accent">View all projects</Text>
            </Pressable>
          )
        }
        renderSectionHeader={({ section }) => (
          <View className="border-b border-divider bg-background px-screen-x pb-2 pt-6">
            <Text accessibilityRole="header" variant="section">{section.title}</Text>
          </View>
        )}
        renderItem={({ item, section }) => (
          <ProjectListRow
            project={item}
            status={section.status}
            context={
              projectStatusContext(
                item,
                tasks,
                conditions,
                projects,
                today,
              )?.rowLabel ?? null
            }
            onPress={() => openProject(item)}
          />
        )}
      />
    </Animated.View>
  );
}

// Home is one reorderable list of loose and project tasks, availability-gated
// by homeTasks. The quick-add defaults to a task and can switch to a project.
export default function HomeScreen() {
  return <TodoHomeScreen />;
}

function TodoHomeScreen() {
  const replica = useTodoReplica();
  const todoData = useTodoDataContext();
  const { signOut: loseAuth } = useAuth();
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Home" showSyncStatus />
      {RUNTIME_PROFILE.hermetic && todoData ? (
        <View className="flex-row gap-4 px-screen-x py-1">
          {todoData.signedIn ? (
            <>
              <Text
                accessibilityRole="button"
                onPress={() => void todoData.signOut()}
                className="text-accent"
              >E2E safe sign out</Text>
              <Text
                accessibilityRole="button"
                onPress={() => void loseAuth()}
                className="text-accent"
              >E2E simulate auth loss</Text>
            </>
          ) : (
            <Text
              accessibilityRole="button"
              onPress={() => router.push('/sign-in')}
              className="text-accent"
            >E2E sign in</Text>
          )}
          <Text variant="subtitle">{`E2E sync: ${todoSyncPresentation(todoData).label}`}</Text>
        </View>
      ) : null}
      {todoData?.error ? <Text variant="error" className="px-screen-x">{todoData.error}</Text> : null}
      {recoveryError ? <Text variant="error" className="px-screen-x">{recoveryError}</Text> : null}
      {todoData?.recoveries.filter((entry) => entry.table !== 'medicines' && entry.table !== 'doses').map((entry) => (
        <View key={`${entry.table}-${entry.id}-${entry.reason}`} className="gap-2 px-screen-x py-1">
          <Text variant="error">
            Recover {entry.table}: {entry.text} — {entry.reason} ({entry.id})
          </Text>
          {entry.repair ? (
            <Host matchContents>
              <Button
                label={entry.repair === 'make-task-loose' ? 'Keep task loose'
                  : entry.repair === 'clear-task-recurrence' ? 'Stop invalid recurrence'
                    : 'Remove invalid After'}
                variant="outlined"
                onPress={() => {
                  setRecoveryError(null);
                  void replica?.repair(entry).catch((error: unknown) => setRecoveryError(String(error)));
                }}
              />
            </Host>
          ) : null}
        </View>
      ))}
      {replica ? (
        <Home replica={replica} />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

function Home({ replica }: { replica: TaskdoReplica }) {
  const { tasks: api, projects: projectsApi, waits: waitsApi } = replica;
  const { getToken } = useAuth();
  const { data: tasks, isLoading } = useLiveQuery((q) =>
    q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: projects, isLoading: projectsLoading } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );
  const { data: conditions, isLoading: conditionsLoading } = useLiveQuery((q) =>
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

  // Do not flash the clear state while the local snapshot hydrates. Every
  // collection reads empty during that window, and attention status depends on
  // all three collections being ready.
  const hydrating = isLoading || projectsLoading || conditionsLoading;

  const [writeError, setWriteError] = useState<string | null>(null);

  const { refreshing, onRefresh } = usePullRefresh(replica.refresh);
  const view = listView({ count: list.length, isLoading });

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
    replica,
    projects: projects ?? [],
    openTasks: tasks ?? [],
    conditions: conditions ?? [],
    onAddWaiting: (project) => projectAdd.openFor(project, 'waiting'),
    onError: setWriteError,
    waitForPersist: true,
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
    modes: ['task', 'project'],
    scope: { kind: 'global' },
    getToken,
    onError: setWriteError,
    fabLabel: 'Task',
    waitForPersist: true,
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
      {writeError ? (
        <Text variant="error" className="px-screen-x">
          {writeError}
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
      ) : view === 'empty' ? (
        hydrating ? (
          <View className="flex-1" />
        ) : (
          <HomeClearState
            projects={projects ?? []}
            tasks={tasks ?? []}
            conditions={conditions ?? []}
            today={today}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
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
        />
      )}

      {detail.sheets}
      {projectAdd.bar}
      {add.bar}
    </>
  );
}
