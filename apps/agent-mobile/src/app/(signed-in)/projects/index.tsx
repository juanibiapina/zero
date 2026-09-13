import { useAuth } from '@clerk/expo';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useRouter } from 'expo-router';
import {
  BACKLOG_COLLAPSE_THRESHOLD, LOADING_TEXT_DELAY_MS, localToday,
  projectDisplayStatus, projectsByStatus, listView, STATUS_LABELS, waitingBadge,
  type Project, type ProjectsApi, type ProjectStatus, type TasksApi, type WaitsApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, RefreshControl, SectionList, View } from 'react-native';
import { useQuickAdd } from '@/components/quick-add-composer';
import { ScreenHeader } from '@/components/screen-header';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useWaitsApi } from '@/lib/waits-collection';
import { useDelayed, useForegroundRefetch, useLoadError, usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

function ProjectRow({ item, waited, onOpen }: {
  item: Project; waited: string | null; onOpen: (p: Project) => void;
}) {
  const icon = <View className="w-[22px] items-center"><Text className="text-[20px]">{item.icon}</Text></View>;
  const trailing = waited ? (
    <Text variant="caption" className="shrink-0" accessibilityLabel={`Waiting ${waited}`}>{waited}</Text>
  ) : undefined;
  return (
    <ListRow leading={icon} trailing={trailing} accessibilityLabel={item.title} onPress={() => onOpen(item)}>
      <Text>{item.title}</Text>
    </ListRow>
  );
}

function SectionHeader({ status, count, collapsed, onToggle }: {
  status: ProjectStatus; count: number; collapsed: boolean;
  onToggle: (status: ProjectStatus, current: boolean) => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${STATUS_LABELS[status]}, ${count}`}
      onPress={() => onToggle(status, collapsed)}
      className="flex-row items-center gap-2 border-b border-divider bg-background px-screen-x pb-2 pt-6">
      <Text variant="section">{collapsed ? '▸' : '▾'} {STATUS_LABELS[status]}</Text>
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
  const [collapseOverride, setCollapseOverride] = useState<Partial<Record<ProjectStatus, boolean>>>({});
  useForegroundRefetch(api.refetch);
  const accent = useColor('--color-accent');
  const refetchAll = useCallback(() => Promise.all([api.refetch(), tasksApi.refetch(), waitsApi.refetch()]), [api, tasksApi, waitsApi]);
  const { refreshing, onRefresh } = usePullRefresh(refetchAll);
  const onToggle = useCallback((status: ProjectStatus, current: boolean) => {
    setCollapseOverride((prev) => ({ ...prev, [status]: !current }));
  }, []);
  const view = listView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);
  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);
  const today = localToday();
  const grouped = useMemo(() => projectsByStatus(
    list,
    (p) => projectDisplayStatus(p, tasks, today, conds, list),
    (p) => waitingBadge(p, tasks, conds, list, today)?.sortKey ?? p.createdAt,
  ), [list, tasks, conds, today]);
  const labelOf = useCallback((p: Project) => waitingBadge(p, tasks, conds, list, today)?.label ?? null, [tasks, conds, list, today]);
  const sections = useMemo(() => grouped.map((s) => {
    const count = s.projects.length;
    const collapsed = collapseOverride[s.status] ?? (s.status === 'backlog' && count > BACKLOG_COLLAPSE_THRESHOLD);
    return { status: s.status, count, data: collapsed ? [] : s.projects, collapsed };
  }), [grouped, collapseOverride]);
  const onProjectCreated = useCallback((id: string) => router.push(`/projects/${id}`), [router]);
  const add = useQuickAdd({
    tasksApi, projectsApi: api, waitsApi, projects: list, modes: ['project'],
    getToken, onError: setWriteError, fabLabel: 'New project', onProjectCreated,
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
          renderItem={({ item }) => <ProjectRow item={item} waited={labelOf(item)} onOpen={onOpen} />}
        />
      )}
      {add.bar}
    </>
  );
}
