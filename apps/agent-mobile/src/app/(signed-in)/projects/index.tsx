import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useRouter } from 'expo-router';
import {
  BACKLOG_COLLAPSE_THRESHOLD,
  DONE_UNDO_MS,
  LOADING_TEXT_DELAY_MS,
  messageOf,
  projectDisplayStatus,
  projectsByStatus,
  listView,
  STATUS_LABELS,
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
  SectionList,
  type TextInput as RNTextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { QuickAdd } from '@/components/quick-add';
import { ScreenHeader } from '@/components/screen-header';
import { ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useWaitsApi } from '@/lib/waits-collection';
import { useCapturesApi } from '@/lib/captures-collection';
import { refiningCaptureId, stopRefine } from '@/lib/refine-session';
import { onProjectLeave } from '@/lib/project-leave';
import { RefineBanner } from '@/components/refine-banner';
import {
  useDelayed,
  useForegroundRefetch,
  useLoadError,
  useUndoableLeave,
} from '@/lib/screen-hooks';

// Helper text (not the placeholder): teach outcome-based naming.
const NAME_HELPER = "Name the outcome you'll reach, so you know when it's done.";

// A project row: emoji icon + title, a single tap target that opens the
// project's own screen. While mid-Done/Delete it is struck-through with an Undo
// instead of tappable.
function ProjectRow({
  item,
  pending,
  onOpen,
  onUndo,
}: {
  item: Project;
  pending: boolean;
  onOpen: (p: Project) => void;
  onUndo: (id: string) => void;
}) {
  const icon = (
    <View className="w-[22px] items-center">
      <Text className="text-[20px]">{item.icon}</Text>
    </View>
  );

  if (pending) {
    return (
      <ListRow
        leading={icon}
        trailing={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Undo"
            hitSlop={8}
            onPress={() => onUndo(item.id)}
          >
            <Text className="font-semibold text-accent">Undo</Text>
          </Pressable>
        }
      >
        <Text className="text-foreground-muted line-through">{item.title}</Text>
      </ListRow>
    );
  }

  return (
    <ListRow leading={icon} accessibilityLabel={item.title} onPress={() => onOpen(item)}>
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
  const capturesApi = useCapturesApi();

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  const [collapseOverride, setCollapseOverride] = useState<
    Partial<Record<ProjectStatus, boolean>>
  >({});
  // Two deferred-undo channels: one for Done, one for Delete.
  const done = useUndoableLeave(DONE_UNDO_MS);
  const del = useUndoableLeave(DONE_UNDO_MS);

  useForegroundRefetch(api.refetch);

  const commitStatus = useCallback(
    (id: string, status: ProjectStatus) => {
      setWriteError(null);
      const tx = api.setStatus(id, status);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
  );

  const startDone = useCallback(
    (id: string) => {
      done.start(id, () => commitStatus(id, 'done'));
    },
    [done, commitStatus],
  );
  const startDelete = useCallback(
    (id: string) => {
      del.start(id, () => {
        setWriteError(null);
        const tx = api.remove(id);
        tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
      });
    },
    [del, api],
  );

  const onUndo = useCallback(
    (id: string) => {
      if (del.pending.has(id)) del.undo(id);
      else done.undo(id);
    },
    [del, done],
  );

  // The detail screen hands Done/Delete back here (it pops before the row leaves
  // the working list, so the ~5s Undo lives on the list). This screen stays
  // mounted beneath the pushed detail, so the handler runs synchronously.
  useEffect(
    () =>
      onProjectLeave(({ id, kind }) => {
        if (kind === 'delete') startDelete(id);
        else startDone(id);
      }),
    [startDelete, startDone],
  );

  const onToggle = useCallback((status: ProjectStatus, current: boolean) => {
    setCollapseOverride((prev) => ({ ...prev, [status]: !current }));
  }, []);

  const view = listView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);
  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);

  const grouped = useMemo(
    () =>
      projectsByStatus(list, (p) => projectDisplayStatus(p, tasks, conds, list)),
    [list, tasks, conds],
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

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    setWriteError(null);
    // When refining a capture, the new project links back to it.
    const tx = api.add(trimmed, refiningCaptureId());
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    setText('');
  }, [text, api]);

  const onFinishRefine = useCallback(
    (captureId: string) => {
      if (!capturesApi) return;
      const tx = capturesApi.process(captureId);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
      stopRefine();
    },
    [capturesApi],
  );

  const closeAdd = useCallback(() => {
    setText('');
    setAdding(false);
  }, []);

  const onOpen = useCallback(
    (p: Project) => router.push(`/projects/${p.id}`),
    [router],
  );

  return (
    <>
      <RefineBanner onFinish={onFinishRefine} />
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
            <ProjectRow
              item={item}
              pending={done.pending.has(item.id) || del.pending.has(item.id)}
              onOpen={onOpen}
              onUndo={onUndo}
            />
          )}
        />
      )}

      <QuickAdd
        open={adding}
        text={text}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={() => onAdd()}
        onRequestClose={closeAdd}
        busy={false}
        inputRef={inputRef}
        fabLabel="New project"
        placeholder="Run a 5K under 30 min"
        helperText={NAME_HELPER}
        bottomOffset={bottomOffset}
      />
    </>
  );
}
