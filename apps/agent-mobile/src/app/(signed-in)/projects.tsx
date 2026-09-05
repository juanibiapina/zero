import { Button, Column, Row, Text as UIText, TextInput } from '@expo/ui';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  BACKLOG_COLLAPSE_THRESHOLD,
  DONE_UNDO_MS,
  ICON_CHOICES,
  localToday,
  LOADING_TEXT_DELAY_MS,
  messageOf,
  projectDisplayStatus,
  projectsByStatus,
  listView,
  STATUS_LABELS,
  type Project,
  type ProjectEditFields,
  type ProjectsApi,
  type ProjectStatus,
  type Task,
  type TasksApi,
  type WaitingCondition,
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
import { CheckCircle, ListRow } from '@/components/ui/list-row';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useWaitsApi } from '@/lib/waits-collection';
import { useColor } from '@/lib/theme';
import {
  useDelayed,
  useForegroundRefetch,
  useLoadError,
  useUndoableLeave,
} from '@/lib/screen-hooks';

// Helper text (not the placeholder): teach outcome-based naming.
const NAME_HELPER = "Name the outcome you'll reach, so you know when it's done.";

// A project row: emoji icon + title, a single tap target that opens the detail
// sheet. While mid-Done/Delete it is struck-through with an Undo instead of
// tappable.
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

// The Status group inside the sheet (native @expo/ui tree). The current status
// is a filled button; the others are outlined.
// active/next/waiting are derived (from taken-on tasks and waiting conditions),
// so the sheet only offers the deliberate manual moves: put a backlog project in
// play, park an in-play one to backlog, or mark it done.
function StatusControls({
  status,
  onPick,
}: {
  status: ProjectStatus;
  onPick: (status: ProjectStatus) => void;
}) {
  const labelColor = useColor('--color-foreground-secondary');
  return (
    <Column spacing={8}>
      <UIText textStyle={{ color: labelColor, fontSize: 13 }}>Status</UIText>
      {status === 'backlog' ? (
        <Button variant="outlined" onPress={() => onPick('next')} label="Put in play" />
      ) : (
        <Button
          variant="outlined"
          onPress={() => onPick('backlog')}
          label="Move to backlog"
        />
      )}
      <Button variant="outlined" onPress={() => onPick('done')} label="Mark done" />
    </Column>
  );
}

// The project's tasks, groomed inside the sheet: complete one with its circle,
// or add a new one (parked by default — grooming is collect-then-take-on, so a
// project-screen task is not surfaced on the Home top region until taken on).
// Reads the shared tasks collection filtered to this project. RN rows live
// inside the @expo/ui Column, like the Delete Pressable below.
function ProjectTasks({
  api,
  projectId,
  onError,
}: {
  api: TasksApi;
  projectId: string;
  onError: (message: string) => void;
}) {
  const labelColor = useColor('--color-foreground-secondary');
  const { data: tasks } = useLiveQuery((q) =>
    q
      .from({ t: api.collection })
      .where(({ t }) => isNull(t.completedAt))
      .orderBy(({ t }) => t.createdAt, 'asc'),
  );
  const list = (tasks ?? []).filter((t: Task) => t.projectId === projectId);
  const [text, setText] = useState('');

  // Plain handlers: the React Compiler memoizes them, so no manual useCallback.
  const onAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const tx = api.add(trimmed, localToday(), projectId);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    setText('');
  };

  const onComplete = (id: string) => {
    const tx = api.complete(id);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };

  // Take a task on (surface it on Home while the project is active) or park it.
  const onToggleTakenOn = (t: Task) => {
    const tx = t.takenOnAt ? api.park(t.id) : api.takeOn(t.id);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };

  return (
    <Column spacing={8}>
      <UIText textStyle={{ color: labelColor, fontSize: 13 }}>Tasks</UIText>
      {list.map((t) => (
        <View key={t.id} className="flex-row items-center gap-3">
          <CheckCircle
            label={`Complete "${t.text}"`}
            onPress={() => onComplete(t.id)}
          />
          <Text className="flex-1">{t.text}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              t.takenOnAt ? `Park "${t.text}"` : `Take on "${t.text}"`
            }
            hitSlop={8}
            onPress={() => onToggleTakenOn(t)}
          >
            <Text
              className={
                t.takenOnAt
                  ? 'text-[18px] text-accent'
                  : 'text-[18px] text-foreground-muted'
              }
            >
              {t.takenOnAt ? '★' : '☆'}
            </Text>
          </Pressable>
        </View>
      ))}
      <Input
        value={text}
        onChangeText={setText}
        onSubmitEditing={onAdd}
        returnKeyType="done"
        blurOnSubmit={false}
        placeholder="Add a task to this project…"
        accessibilityLabel="Add a task to this project"
      />
    </Column>
  );
}

// A human label for a waiting condition.
function conditionLabel(
  c: WaitingCondition,
  tasks: Task[],
  projects: Project[],
): string {
  if (c.kind === 'free-text') return c.text ?? '(unspecified)';
  if (c.kind === 'task-done') {
    const t = tasks.find((x) => x.id === c.refId);
    return `until “${t?.text ?? '?'}” is done`;
  }
  const p = projects.find((x) => x.id === c.refId);
  return `until “${p?.title ?? '?'}” is ${c.targetStatus}`;
}

// The waiting conditions for a project: list the open ones (resolve/delete) and
// add a free-text one. Structured kinds (task-done, project-status) are created
// on web for now; here they still render with a label and auto-resolve in code.
function ProjectWaits({
  project,
  waitsApi,
  tasksApi,
  projects,
  onError,
}: {
  project: Project;
  waitsApi: WaitsApi;
  tasksApi: TasksApi;
  projects: Project[];
  onError: (message: string) => void;
}) {
  const labelColor = useColor('--color-foreground-secondary');
  const { data: allConditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const { data: openTasks } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const list = (allConditions ?? []).filter(
    (c: WaitingCondition) => c.projectId === project.id,
  );
  const tasks = openTasks ?? [];
  const [text, setText] = useState('');

  const write = (tx: { isPersisted: { promise: Promise<unknown> } }) => {
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };
  const onAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    write(waitsApi.add(project.id, 'free-text', { text: trimmed }));
    setText('');
  };

  return (
    <Column spacing={8}>
      <UIText textStyle={{ color: labelColor, fontSize: 13 }}>Waiting on</UIText>
      {list.map((c) => (
        <View key={c.id} className="flex-row items-center gap-2">
          <Text className="flex-1 text-[14px]">
            {conditionLabel(c, tasks, projects)}
          </Text>
          {c.kind === 'free-text' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Resolve condition"
              hitSlop={8}
              onPress={() => write(waitsApi.resolve(c.id))}
            >
              <Text className="text-[13px] font-semibold text-accent">Resolve</Text>
            </Pressable>
          ) : (
            <Text className="text-[12px] text-foreground-muted">auto</Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete condition"
            hitSlop={8}
            onPress={() => write(waitsApi.remove(c.id))}
          >
            <Text className="text-[16px] text-foreground-muted">✕</Text>
          </Pressable>
        </View>
      ))}
      <Input
        value={text}
        onChangeText={setText}
        onSubmitEditing={onAdd}
        returnKeyType="done"
        blurOnSubmit={false}
        placeholder="Waiting on… (e.g. the letter comes back)"
        accessibilityLabel="Waiting condition"
      />
    </Column>
  );
}

// The detail sheet body (native @expo/ui tree): an icon picker, an editable
// title and notes field, the project's tasks, and the Status group. Edits commit
// on blur/submit and keep the sheet open; only a status pick dismisses it. Keyed
// by project id at the call site, so the seeded field state resets per project.
// Colors come from tokens via useColor (@expo/ui takes string colors, not classes).
function ProjectDetail({
  project,
  tasksApi,
  waitsApi,
  allProjects,
  onError,
  onEdit,
  onPickStatus,
  onDelete,
}: {
  project: Project;
  tasksApi: TasksApi;
  waitsApi: WaitsApi;
  allProjects: Project[];
  onError: (message: string) => void;
  onEdit: (id: string, fields: ProjectEditFields) => void;
  onPickStatus: (status: ProjectStatus) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? '');

  const labelColor = useColor('--color-foreground-secondary');
  const surfaceMuted = useColor('--color-surface-muted');
  const foreground = useColor('--color-foreground');
  const label = { color: labelColor, fontSize: 13 } as const;
  const inputStyle = {
    backgroundColor: surfaceMuted,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  } as const;
  const inputText = { color: foreground, fontSize: 16 } as const;

  const commitTitle = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed === '' || trimmed === project.title) {
      setTitle(project.title);
      return;
    }
    onEdit(project.id, { title: trimmed });
  }, [title, project.id, project.title, onEdit]);

  const commitDescription = useCallback(() => {
    const next = description.trim() === '' ? null : description;
    if ((next ?? null) === (project.description ?? null)) return;
    onEdit(project.id, { description: next });
  }, [description, project.id, project.description, onEdit]);

  return (
    <Column spacing={12}>
      <UIText textStyle={label}>Icon</UIText>
      <Row spacing={8}>
        {ICON_CHOICES.map((icon) => (
          <Button
            key={icon}
            variant={icon === project.icon ? 'filled' : 'outlined'}
            onPress={() => onEdit(project.id, { icon })}
            label={icon}
          />
        ))}
      </Row>

      <UIText textStyle={label}>Title</UIText>
      <TextInput
        defaultValue={project.title}
        onChangeText={setTitle}
        onBlur={commitTitle}
        returnKeyType="done"
        onSubmitEditing={commitTitle}
        placeholder="Project name"
        style={inputStyle}
        textStyle={inputText}
      />

      <UIText textStyle={label}>Notes</UIText>
      <TextInput
        defaultValue={project.description ?? ''}
        onChangeText={setDescription}
        onBlur={commitDescription}
        multiline
        placeholder="A sentence of intent (optional)"
        style={inputStyle}
        textStyle={inputText}
      />

      <ProjectTasks api={tasksApi} projectId={project.id} onError={onError} />

      <ProjectWaits
        project={project}
        waitsApi={waitsApi}
        tasksApi={tasksApi}
        projects={allProjects}
        onError={onError}
      />

      <StatusControls status={project.status} onPick={onPickStatus} />

      {/* Destructive: hard-delete the project (distinct from Done). Leaves a
          brief Undo window before it commits. A plain Pressable with danger
          text, since @expo/ui Button has no destructive role. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Delete project"
        onPress={onDelete}
        className="items-center py-3"
      >
        <Text className="font-semibold text-danger">Delete project</Text>
      </Pressable>
    </Column>
  );
}

// Projects is entity #3: outcome-oriented containers grouped by status. The
// quick-add creates one by name; tapping a row opens the detail sheet.
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

  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  // Edit a project's icon/title/notes from the sheet; keeps the sheet open.
  const commitEdit = useCallback(
    (id: string, fields: ProjectEditFields) => {
      setWriteError(null);
      const tx = api.edit(id, fields);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
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

  const onPickStatus = useCallback(
    (project: Project, status: ProjectStatus) => {
      setSelectedId(null);
      if (status === project.status) return;
      if (status === 'done') {
        done.start(project.id, () => commitStatus(project.id, 'done'));
      } else {
        commitStatus(project.id, status);
      }
    },
    [commitStatus, done],
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

  // Android back: dismiss the sheet, then close the quick-add, before leaving.
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<RNTextInput>(null);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedId) {
        setSelectedId(null);
        return true;
      }
      if (adding) {
        setText('');
        setAdding(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selectedId, adding]);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    setWriteError(null);
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    setText('');
  }, [text, api]);

  const closeAdd = useCallback(() => {
    setText('');
    setAdding(false);
  }, []);

  const selected = selectedId
    ? (list.find((p) => p.id === selectedId) ?? null)
    : null;

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
              onOpen={(p) => setSelectedId(p.id)}
              onUndo={onUndo}
            />
          )}
        />
      )}

      <Sheet open={selected != null} onClose={() => setSelectedId(null)}>
        {selected ? (
          <ProjectDetail
            key={selected.id}
            project={selected}
            tasksApi={tasksApi}
            waitsApi={waitsApi}
            allProjects={list}
            onError={setWriteError}
            onEdit={commitEdit}
            onPickStatus={(status) => onPickStatus(selected, status)}
            onDelete={() => {
              setSelectedId(null);
              startDelete(selected.id);
            }}
          />
        ) : null}
      </Sheet>

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
