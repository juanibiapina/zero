import { useAuth } from '@clerk/expo';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useRouter } from 'expo-router';
import {
  LOADING_TEXT_DELAY_MS,
  projectStatusSections, listView,
  PROJECT_DISPLAY_STATUS_LABELS, projectStatusContext,
  type Project, type ProjectsApi, type ProjectDisplayStatus, type TasksApi,
  type WaitsApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, RefreshControl, SectionList, View } from 'react-native';
import { useQuickAdd } from '@/components/quick-add-composer';
import { ScreenHeader } from '@/components/screen-header';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useLocalDay } from '@/lib/local-day';
import { useProjectsApi, useTasksApi, useWaitsApi } from '@/lib/todo-api-hooks';
import { useDelayed, useForegroundRefetch, useLoadError, usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

function ProjectRow({ item, status, context, onOpen }: {
  item: Project; status: ProjectDisplayStatus; context: string | null;
  onOpen: (p: Project) => void;
}) {
  const icon = <View className="w-[22px] items-center"><Text className="text-[20px]">{item.icon}</Text></View>;
  const trailing = context ? (
    <Text
      numberOfLines={1}
      variant="caption"
      className="max-w-[50%] shrink-0"
      accessibilityLabel={
        status === 'after'
          ? `After ${context.replace(/^after /, '')}`
          : `${PROJECT_DISPLAY_STATUS_LABELS[status]} ${context}`
      }
    >
      {context}
    </Text>
  ) : undefined;
  return (
    <ListRow leading={icon} trailing={trailing} accessibilityLabel={item.title} onPress={() => onOpen(item)}>
      <Text>{item.title}</Text>
    </ListRow>
  );
}

function SectionHeader({ status, count, collapsed, onToggle }: {
  status: ProjectDisplayStatus; count: number; collapsed: boolean;
  onToggle: (status: ProjectDisplayStatus, current: boolean) => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${PROJECT_DISPLAY_STATUS_LABELS[status]}, ${count}`}
      accessibilityState={{ expanded: !collapsed }}
      onPress={() => onToggle(status, collapsed)}
      className="flex-row items-center gap-2 border-b border-divider bg-background px-screen-x pb-2 pt-6">
      <Text variant="section">{collapsed ? '▸' : '▾'} {PROJECT_DISPLAY_STATUS_LABELS[status]}</Text>
      <Text variant="caption">· {count}</Text>
    </Pressable>
  );
}

export default function ProjectsScreen() {
  const projectsApi = useProjectsApi();
  const tasksApi = useTasksApi();
  const waitsApi = useWaitsApi();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Projects" />
      {projectsApi && tasksApi && waitsApi ? (
        <Projects api={projectsApi} tasksApi={tasksApi} waitsApi={waitsApi} />
      ) : <View className="flex-1" />}
    </View>
  );
}

function Projects({ api, tasksApi, waitsApi }: {
  api: ProjectsApi; tasksApi: TasksApi; waitsApi: WaitsApi;
}) {
  const router = useRouter();
  const { getToken } = useAuth();
  const { data: projects, isLoading } = useLiveQuery((q) =>
    q.from({ p: api.collection }).orderBy(({ p }) => p.createdAt, 'asc'));
  const { data: openTasks } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)));
  const { data: conditions } = useLiveQuery((q) => q.from({ w: waitsApi.collection }));
  const list = useMemo(() => projects ?? [], [projects]);
  const tasks = useMemo(() => openTasks ?? [], [openTasks]);
  const conds = useMemo(() => conditions ?? [], [conditions]);
  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [collapseOverride, setCollapseOverride] = useState<Partial<Record<ProjectDisplayStatus, boolean>>>({});
  const accent = useColor('--color-accent');
  const refetchAll = useCallback(async () => { await Promise.all([api.refetch(), tasksApi.refetch(), waitsApi.refetch()]); }, [api, tasksApi, waitsApi]);
  useForegroundRefetch(refetchAll);
  const { refreshing, onRefresh } = usePullRefresh(refetchAll);
  const onToggle = useCallback((status: ProjectDisplayStatus, current: boolean) => {
    setCollapseOverride((prev) => ({ ...prev, [status]: !current }));
  }, []);
  const view = listView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);
  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);
  const today = useLocalDay();
  const grouped = useMemo(() => projectStatusSections({
    projects: list, tasks, conditions: conds, today, collapseOverride,
  }), [list, tasks, conds, today, collapseOverride]);
  const labelOf = useCallback((p: Project) => projectStatusContext(p, tasks, conds, list, today)?.rowLabel ?? null, [tasks, conds, list, today]);
  const sections = useMemo(() => grouped.map((s) => ({
    status: s.status, count: s.count, data: s.collapsed ? [] : s.projects, collapsed: s.collapsed,
  })), [grouped]);
  const onProjectCreated = useCallback((id: string) => router.push(`/projects/${id}`), [router]);
  const add = useQuickAdd({
    tasksApi, projectsApi: api, projects: list, openTasks: tasks, conditions: conds, modes: ['project', 'task'],
    scope: { kind: 'global' }, getToken, onError: setWriteError,
    fabLabel: 'Add', onProjectCreated,
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', add.handleBack);
    return () => sub.remove();
  }, [add.handleBack]);
  const onOpen = useCallback((p: Project) => router.push(`/projects/${p.id}`), [router]);
  return (
    <>
      {error ? <Text variant="error" className="px-screen-x">{error}</Text> : null}
      {view === 'loading' ? (
        showLoadingText ? <Text variant="subtitle" className="px-screen-x">Loading your projects…</Text> : <View className="flex-1" />
      ) : view === 'empty' ? (
        <Text variant="subtitle" className="px-screen-x">No projects yet. Name your first outcome.</Text>
      ) : (
        <SectionList style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 96 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accent} colors={[accent]} />}
          sections={sections} keyExtractor={(item) => item.id} stickySectionHeadersEnabled
          renderSectionHeader={({ section }) => <SectionHeader status={section.status} count={section.count} collapsed={section.collapsed} onToggle={onToggle} />}
          renderItem={({ item, section }) => <ProjectRow item={item} status={section.status} context={labelOf(item)} onOpen={onOpen} />}
        />
      )}
      {add.bar}
    </>
  );
}
