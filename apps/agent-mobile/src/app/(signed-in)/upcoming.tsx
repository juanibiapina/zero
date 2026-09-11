import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  dayLabel,
  localToday,
  upcomingSections,
  type ProjectsApi,
  type Task,
  type TasksApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, RefreshControl, SectionList, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useTaskDetail } from '@/components/task-detail';
import { CheckCircle, ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

// One upcoming row: tap the circle to complete, tap the text to open the task
// detail — the same editor Home opens. No drag-reorder or swipe — ordering across
// days has no meaning here.
function UpcomingRow({
  item,
  onComplete,
  onOpen,
}: {
  item: Task;
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
      <Text>{item.text}</Text>
    </ListRow>
  );
}

// Upcoming lists tasks scheduled for a future day, grouped into day sections.
// The complement of Home: what has shown up stays on Home, what is still ahead
// shows here — every future-dated open task, loose or project, no other gate.
export default function UpcomingScreen() {
  const tasksApi = useTasksApi();
  const projectsApi = useProjectsApi();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Upcoming" />
      {tasksApi && projectsApi ? (
        <Upcoming api={tasksApi} projectsApi={projectsApi} />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

function Upcoming({
  api,
  projectsApi,
}: {
  api: TasksApi;
  projectsApi: ProjectsApi;
}) {
  const { data: tasks } = useLiveQuery((q) =>
    q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: projects } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );

  const today = localToday();
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

  // The task detail editor — the same one Home opens — owns the sheet,
  // scheduler, edit-on-dismiss, and complete-with-Undo.
  const detail = useTaskDetail({
    api,
    list,
    projects: projects ?? [],
    onError: setWriteError,
  });

  // Android Back closes the scheduler, then the detail sheet. Upcoming has no
  // quick-add, so the hook is the only Back consumer here.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () =>
      detail.handleBack(),
    );
    return () => sub.remove();
  }, [detail]);

  const accent = useColor('--color-accent');
  const { refreshing, onRefresh } = usePullRefresh(api.refetch);

  const renderItem = useCallback(
    ({ item }: { item: Task }) => (
      <UpcomingRow item={item} onComplete={detail.complete} onOpen={detail.open} />
    ),
    [detail.complete, detail.open],
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
    </>
  );
}
