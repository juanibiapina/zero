import { useAuth } from '@clerk/expo';
import { router } from 'expo-router';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  dayLabel,
  taskIcon,
  upcomingSections,
  type Task,
  type TaskdoReplica,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, RefreshControl, SectionList, View } from 'react-native';

import { useProjectAdd } from '@/components/project-add';
import { ScreenHeader } from '@/components/screen-header';
import { useTaskDetail } from '@/components/task-detail';
import { CheckCircle, ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useLocalDay } from '@/lib/local-day';
import { useTodoReplica } from '@/lib/todo-replica-hook';
import { usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

// One upcoming row: tap the circle to complete, tap the text to open the task
// detail — the same editor Home opens. No drag-reorder or swipe — ordering across
// days has no meaning here. A project task shows its project's icon glyph before
// the title (same as Home); a loose task shows none.
function UpcomingRow({
  item,
  icon,
  onComplete,
  onOpen,
}: {
  item: Task;
  // The task's project icon, or null for a loose task (shows no glyph).
  icon: string | null;
  onComplete: (item: Task) => void;
  onOpen: (item: Task) => void;
}) {
  return (
    <ListRow
      leading={
        <CheckCircle label={`Complete "${item.text}"`} onPress={() => onComplete(item)} />
      }
      onPress={() => onOpen(item)}
      accessibilityLabel={`Edit "${item.text}"`}
    >
      <View className="flex-row items-center gap-3">
        {icon != null ? <Text className="text-[16px]">{icon}</Text> : null}
        <Text className="flex-1">{item.text}</Text>
      </View>
    </ListRow>
  );
}

// Upcoming lists tasks scheduled for a future day, grouped into day sections.
// The complement of Home: what has shown up stays on Home, what is still ahead
// shows here — every future-dated open task, loose or project, no other gate.
export default function UpcomingScreen() {
  const replica = useTodoReplica();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Upcoming" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to Browse"
        onPress={() => router.back()}
        className="min-h-12 justify-center px-screen-x"
      >
        <Text className="text-accent">‹ Browse</Text>
      </Pressable>
      {replica ? (
        <Upcoming replica={replica} />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

function Upcoming({ replica }: { replica: TaskdoReplica }) {
  const { tasks: api, projects: projectsApi, waits: waitsApi } = replica;
  const { getToken } = useAuth();
  const { data: tasks } = useLiveQuery((q) =>
    q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: projects } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );

  const today = useLocalDay();
  const sections = useMemo(
    () =>
      upcomingSections(tasks ?? [], today).map((s) => ({
        date: s.date,
        data: s.tasks,
      })),
    [tasks, today],
  );
  // The flat list of visible upcoming tasks, so the detail editor resolves the
  // tapped task and drops it (closing the sheet) when rescheduled to today.
  const list = useMemo(() => sections.flatMap((s) => s.data), [sections]);

  const [writeError, setWriteError] = useState<string | null>(null);
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
  });

  // Android Back closes the deepest task or Project-add surface first.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail.handleBack()) return true;
      return projectAdd.handleBack();
    });
    return () => sub.remove();
  }, [detail, projectAdd]);

  const accent = useColor('--color-accent');
  const { refreshing, onRefresh } = usePullRefresh(replica.refresh);

  const renderItem = useCallback(
    ({ item }: { item: Task }) => (
      <UpcomingRow
        item={item}
        icon={taskIcon(item, projects ?? [])}
        onComplete={detail.complete}
        onOpen={detail.open}
      />
    ),
    [detail.complete, detail.open, projects],
  );

  return (
    <>
      {writeError ? (
        <Text variant="error" className="px-screen-x">
          {writeError}
        </Text>
      ) : null}

      <SectionList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 96 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={accent}
            colors={[accent]}
          />
        }
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <View className="bg-background px-screen-x pb-2 pt-6">
            <Text variant="section">{dayLabel(section.date, today)}</Text>
            <View className="mt-2 h-px bg-divider" />
          </View>
        )}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text variant="subtitle" className="px-screen-x">
            Nothing scheduled ahead.
          </Text>
        }
      />

      {detail.sheets}
      {projectAdd.bar}
    </>
  );
}
