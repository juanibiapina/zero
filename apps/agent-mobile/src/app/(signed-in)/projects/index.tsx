import { useAuth } from '@clerk/expo';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useRouter } from 'expo-router';
import {
  BACKLOG_COLLAPSE_THRESHOLD,
  LOADING_TEXT_DELAY_MS,
  localToday,
  messageOf,
  projectDisplayStatus,
  projectsByStatus,
  listView,
  STATUS_LABELS,
  waitingBadge,
  type Project,
  type ProjectsApi,
  type ProjectStatus,
  type TasksApi,
  type WaitsApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  RefreshControl,
  SectionList,
  type TextInput as RNTextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { QuickAdd } from '@/components/quick-add';
import { ScreenHeader } from '@/components/screen-header';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { requestIconSuggestions } from '@/lib/icon-suggestions';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useWaitsApi } from '@/lib/waits-collection';
import {
  useDelayed,
  useForegroundRefetch,
  useLoadError,
  usePullRefresh,
} from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

// A project row: emoji icon + title, a single tap target that opens the
// project's own screen. Done and Delete both happen on the project's own screen
// and commit immediately, so the row simply drops from the list — it has no
// transient state of its own.
function ProjectRow({
  item,
  waited,
  onOpen,
}: {
  item: Project;
  waited: string | null;
  onOpen: (p: Project) => void;
}) {
  const icon = (
    <View className="w-[22px] items-center">
      <Text className="text-[20px]">{item.icon}</Text>
    </View>
  );

  // A muted trailing "how long waiting" label, shown only for waiting rows. The
  // Waiting section header frames it, so the badge carries only the magnitude.
  const trailing = waited ? (
    <Text
      variant="caption"
      className="shrink-0"
      accessibilityLabel={`Waiting ${waited}`}
    >
      {waited}
    </Text>
  ) : undefined;

  return (
    <ListRow
      leading={icon}
      trailing={trailing}
      accessibilityLabel={item.title}
      onPress={() => onOpen(item)}
    >
      <Text>{item.title}</Text>
    </ListRow>
  );
}

// A collapsible sticky section header: label, count, and a collapse toggle.
function SectionHeader({
  status,
  count,
  collapsed,
  onToggle,
}: {
  status: ProjectStatus;
  count: number;
  collapsed: boolean;
  onToggle: (status: ProjectStatus, current: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${STATUS_LABELS[status]}, ${count}`}
      onPress={() => onToggle(status, collapsed)}
      className="flex-row items-center gap-2 border-b border-divider bg-background px-screen-x pb-2 pt-6"
    >
      <Text variant="section">
        {collapsed ? '▸' : '▾'} {STATUS_LABELS[status]}
      </Text>
      <Text variant="caption">· {count}</Text>
    </Pressable>
  );
}

// Projects is entity #3: outcome-oriented containers grouped by status. The
// quick-add creates one by name; tapping a row pushes that project's own screen.
export default function ProjectsScreen() {
  const projectsApi = useProjectsApi();
  const tasksApi = useTasksApi();
  const waitsApi = useWaitsApi();

  const { height: windowHeight } = useWindowDimensions();
  const rootRef = useRef<View>(null);
  const [bottomOffset, setBottomOffset] = useState(0);
  const measureBottomGap = useCallback(() => {
    rootRef.current?.measureInWindow((_x, y, _w, h) => {
      setBottomOffset(Math.max(0, windowHeight - (y + h)));
    });
  }, [windowHeight]);

  return (
    <View ref={rootRef} onLayout={measureBottomGap} className="flex-1 bg-background">
      <ScreenHeader title="Projects" />
      {projectsApi && tasksApi && waitsApi ? (
        <Projects
          api={projectsApi}
          tasksApi={tasksApi}
          waitsApi={waitsApi}
          bottomOffset={bottomOffset}
        />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

function Projects({
  api,
  tasksApi,
  waitsApi,
  bottomOffset,
}: {
  api: ProjectsApi;
  tasksApi: TasksApi;
  waitsApi: WaitsApi;
  bottomOffset: number;
}) {
  const router = useRouter();
  const { getToken } = useAuth();
  const { data: projects, isLoading } = useLiveQuery((q) =>
    q.from({ p: api.collection }).orderBy(({ p }) => p.createdAt, 'asc'),
  );
  // Open tasks drive each project's derived display status (active vs next).
  const { data: openTasks } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  // Open waiting conditions make a project display as waiting.
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const list = useMemo(() => projects ?? [], [projects]);
  const tasks = useMemo(() => openTasks ?? [], [openTasks]);
  const conds = useMemo(() => conditions ?? [], [conditions]);

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  const [collapseOverride, setCollapseOverride] = useState<
    Partial<Record<ProjectStatus, boolean>>
  >({});

  useForegroundRefetch(api.refetch);

  const accent = useColor('--color-accent');
  // A project's display status is derived from its tasks and waits, so a pull
  // re-pulls all three lists that this screen shows.
  const refetchAll = useCallback(
    () => Promise.all([api.refetch(), tasksApi.refetch(), waitsApi.refetch()]),
    [api, tasksApi, waitsApi],
  );
  const { refreshing, onRefresh } = usePullRefresh(refetchAll);

  const onToggle = useCallback((status: ProjectStatus, current: boolean) => {
    setCollapseOverride((prev) => ({ ...prev, [status]: !current }));
  }, []);

  const view = listView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);
  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);

  const today = localToday();
  const grouped = useMemo(
    () =>
      projectsByStatus(
        list,
        (p) => projectDisplayStatus(p, tasks, today, conds, list),
        // Order the Waiting section by the shared badge's sort key (condition
        // waits longest-first, then date waits soonest-first); other sections
        // fall back to createdAt.
        (p) => waitingBadge(p, tasks, conds, list, today)?.sortKey ?? p.createdAt,
      ),
    [list, tasks, conds, today],
  );
  // A project's waiting badge text, non-null only for waiting projects: elapsed
  // time for a condition wait, "until <day>" for a date wait.
  const labelOf = useCallback(
    (p: Project) => waitingBadge(p, tasks, conds, list, today)?.label ?? null,
    [tasks, conds, list, today],
  );

  // Collapse is derived, not stored: a section uses the user's explicit override
  // when present, else the default (a large Backlog starts collapsed).
  const sections = useMemo(
    () =>
      grouped.map((s) => {
        const count = s.projects.length;
        const isCollapsed =
          collapseOverride[s.status] ??
          (s.status === 'backlog' && count > BACKLOG_COLLAPSE_THRESHOLD);
        return {
          status: s.status,
          count,
          data: isCollapsed ? [] : s.projects,
          collapsed: isCollapsed,
        };
      }),
    [grouped, collapseOverride],
  );

  // Android back closes the quick-add before leaving the screen.
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<RNTextInput>(null);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (adding) {
        setText('');
        setAdding(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [adding]);

  const closeAdd = useCallback(() => {
    setText('');
    setAdding(false);
  }, []);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    setWriteError(null);
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    // Pre-warm emoji icon suggestions off the optimistic insert's id, so the
    // picker shows them instantly when opened (create is name-only, so the basis
    // is the title alone). Fire-and-forget; a failure only costs the shortcut.
    const key = tx.mutations[0]?.key as string | number | undefined;
    if (key !== undefined) {
      void requestIconSuggestions(getToken, String(key), {
        title: trimmed,
        description: null,
      });
      // Open the new project's own screen right away: the id is client-minted
      // and the optimistic row is already in the collection, so its screen
      // renders at once (before the server confirms).
      router.push(`/projects/${key}`);
    }
    // Close the quick-add after adding.
    closeAdd();
  }, [text, api, getToken, router, closeAdd]);

  const onOpen = useCallback(
    (p: Project) => router.push(`/projects/${p.id}`),
    [router],
  );

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
            Loading your projects…
          </Text>
        ) : (
          <View className="flex-1" />
        )
      ) : view === 'empty' ? (
        <Text variant="subtitle" className="px-screen-x">
          No projects yet. Name your first outcome.
        </Text>
      ) : (
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
          stickySectionHeadersEnabled
          renderSectionHeader={({ section }) => (
            <SectionHeader
              status={section.status}
              count={section.count}
              collapsed={section.collapsed}
              onToggle={onToggle}
            />
          )}
          renderItem={({ item }) => (
            <ProjectRow item={item} waited={labelOf(item)} onOpen={onOpen} />
          )}
        />
      )}

      <QuickAdd
        open={adding}
        text={text}
        // The Projects list only creates projects, so it shows the single
        // Project mode pill — reading like Home's pills and the project screen's
        // sole Task pill. One mode, so tapping the pill is a no-op reselect.
        mode="project"
        modes={['project']}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={() => onAdd()}
        onRequestClose={closeAdd}
        busy={false}
        inputRef={inputRef}
        fabLabel="New project"
        placeholder="Name an outcome"
        bottomOffset={bottomOffset}
      />
    </>
  );
}
