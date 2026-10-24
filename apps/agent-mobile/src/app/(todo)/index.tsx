import { Button, Host } from '@expo/ui';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  listView,
  LOADING_TEXT_DELAY_MS,
  homeTasks,
  taskIcon,
  todoSyncPresentation,
  type Task,
  type TaskdoReplica,
} from '@zero/agent-core';
import { useAuth } from '@clerk/expo';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BackHandler,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { useTodoDataContext } from '@/lib/todo-data-context';
import { NightRoutineButton } from '@/components/night-routine';
import { RecordButton } from '@/components/record-button';
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

function HomeAllDone({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const accent = useColor('--color-accent');

  return (
    <Animated.View
      entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
      style={{ flex: 1 }}
    >
      <ScrollView
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
      >
        <View className="flex-1 items-center justify-center gap-4 px-screen-x">
          <View
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            className="h-20 w-20 items-center justify-center rounded-full bg-surface-muted"
          >
            <Text className="text-[40px] text-foreground-secondary">✓</Text>
          </View>
          <Text variant="title">All done</Text>
        </View>
      </ScrollView>
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
      <ScreenHeader title="Home" showSyncStatus action={<><RecordButton /><NightRoutineButton /></>} />
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
      {todoData?.recoveries.filter((entry) => entry.table !== 'medicines' && entry.table !== 'doses' && entry.table !== 'intakes').map((entry) => (
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

  // The + drawer. Task feedback opens it for that Task's Project on Waiting.
  const add = useQuickAdd({
    replica,
    surface: { kind: 'home' },
    onError: setWriteError,
  });

  const detail = useTaskDetail({
    replica,
    projects: projects ?? [],
    openTasks: tasks ?? [],
    conditions: conditions ?? [],
    onAddWaiting: (project) => add.open('waiting', project),
    onError: setWriteError,
    waitForPersist: true,
  });

  // A project task's icon (defaulting to the neutral one); a loose task has none.
  // The rule lives in the shared taskIcon resolver, so Home and Upcoming agree.
  const presentationOf = useCallback(
    (item: Task) => ({ icon: taskIcon(item, projects ?? []) }),
    [projects],
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', add.handleBack);
    return () => sub.remove();
  }, [add.handleBack]);

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
          <HomeAllDone
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
      {add.element}
    </>
  );
}
