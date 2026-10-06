import { taskRecurrenceLabel } from '@zero/agent-core';
import { TaskRecurrence } from '@/components/task-recurrence';
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
import { BackHandler, RefreshControl, SectionList, View } from 'react-native';

import { useQuickAdd } from '@/components/quick-add-composer';
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
      accessibilityLabel={[`Edit "${item.text}"`, taskRecurrenceLabel(item)].filter(Boolean).join(', ')}
    >
      <View className="gap-0.5">
        <View className="flex-row items-center gap-3">
          {icon != null ? <Text className="text-[16px]">{icon}</Text> : null}
          <Text className="flex-1">{item.text}</Text>
        </View>
        <TaskRecurrence task={item} />
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
      <ScreenHeader title="Upcoming" backToBrowse />
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
  const [writeError, setWriteError] = useState<string | null>(null);
  // Upcoming has no +; task feedback opens the drawer for that Task's Project.
  const add = useQuickAdd({
    replica,
    surface: { kind: 'upcoming' },
    onError: setWriteError,
  });

  const detail = useTaskDetail({
    replica,
    projects: projects ?? [],
    openTasks: tasks ?? [],
    conditions: conditions ?? [],
    onAddWaiting: (project) => add.open('waiting', project),
    onError: setWriteError,
  });

  // Android Back closes the deepest task or Project-add surface first.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail.handleBack()) return true;
      return add.handleBack();
    });
    return () => sub.remove();
  }, [detail, add]);

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
      {add.element}
    </>
  );
}
