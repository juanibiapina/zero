import { Button, Column } from '@expo/ui';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  localToday,
  messageOf,
  projectDisplayStatus,
  STATUS_LABELS,
  type Project,
  type ProjectEditFields,
  type ProjectStatus,
  type ProjectsApi,
  type Task,
  type TasksApi,
  type WaitingCondition,
  type WaitsApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  RefreshControl,
  ScrollView,
  type TextInput as RNTextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import EmojiPicker, { type EmojiType } from 'rn-emoji-keyboard';
import { CheckCircle } from '@/components/ui/list-row';
import { Input } from '@/components/ui/input';
import { QuickAdd } from '@/components/quick-add';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useWaitsApi } from '@/lib/waits-collection';
import { refiningCaptureId } from '@/lib/refine-session';
import { requestProjectLeave } from '@/lib/project-leave';
import { usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

// A project's own screen (pushed within the Projects tab). This is a plain React
// Native view tree — NOT an @expo/ui native tree — so its task and waiting rows
// render like every other list screen. (The old bottom-sheet detail dropped raw
// RN rows inside an @expo/ui Column, which the native host cannot lay out; that
// is the bug this screen removes.) The two short sub-interactions — the icon
// picker and the status/delete actions — are the only @expo/ui here, each a pure
// @expo/ui sheet. See docs/plans/todo-project-detail-rework.md.
export default function ProjectDetailScreen() {
  const projectsApi = useProjectsApi();
  const tasksApi = useTasksApi();
  const waitsApi = useWaitsApi();
  return projectsApi && tasksApi && waitsApi ? (
    <ProjectDetail api={projectsApi} tasksApi={tasksApi} waitsApi={waitsApi} />
  ) : (
    <View className="flex-1 bg-background" />
  );
}

function BackRow({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 12 }} className="px-screen-x pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to projects"
        hitSlop={8}
        onPress={onBack}
      >
        <Text className="text-[16px] text-accent">‹ Projects</Text>
      </Pressable>
    </View>
  );
}

function ProjectDetail({
  api,
  tasksApi,
  waitsApi,
}: {
  api: ProjectsApi;
  tasksApi: TasksApi;
  waitsApi: WaitsApi;
}) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const back = useCallback(() => router.back(), [router]);
  const [error, setError] = useState<string | null>(null);

  // Adding a task is a plus FAB that expands into the shared keyboard-docked
  // quick-add bar (like Home and the Projects list), not an inline field. The
  // bar is task-only — no capture mode — so what you add here lands in this
  // project. See docs/plans/todo-project-task-add-fab.md.
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<RNTextInput>(null);

  // Measure the gap from this screen's content bottom to the window bottom (the
  // native bottom tab bar plus the system gesture inset), fed to the
  // keyboard-sticky quick-add so it docks flush to the keyboard.
  const { height: windowHeight } = useWindowDimensions();
  const rootRef = useRef<View>(null);
  const [bottomOffset, setBottomOffset] = useState(0);
  const measureBottomGap = useCallback(() => {
    rootRef.current?.measureInWindow((_x, y, _w, h) => {
      setBottomOffset(Math.max(0, windowHeight - (y + h)));
    });
  }, [windowHeight]);

  const { data: projects } = useLiveQuery((q) =>
    q.from({ p: api.collection }).orderBy(({ p }) => p.createdAt, 'asc'),
  );
  const { data: openTasks } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );

  const list = projects ?? [];
  const tasks = openTasks ?? [];
  const conds = conditions ?? [];
  const project = list.find((p) => p.id === id) ?? null;

  const commitEdit = useCallback(
    (fields: ProjectEditFields) => {
      if (!project) return;
      setError(null);
      const tx = api.edit(project.id, fields);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api, project],
  );

  const commitStatus = useCallback(
    (status: ProjectStatus) => {
      if (!project) return;
      setError(null);
      const tx = api.setStatus(project.id, status);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api, project],
  );

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Submitting an empty input closes the quick-add bar.
      setAdding(false);
      return;
    }
    if (!project) return;
    setError(null);
    // Parked by default (takenOnAt null) — grooming is collect-then-take-on;
    // linked to the capture when refining. Keep the bar open and cleared for
    // rapid entry.
    const tx = tasksApi.add(
      trimmed,
      localToday(),
      project.id,
      null,
      refiningCaptureId(),
    );
    tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    setText('');
  }, [text, tasksApi, project]);

  const closeAdd = useCallback(() => {
    setText('');
    setAdding(false);
  }, []);

  // Android hardware Back closes the quick-add before it pops the screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (adding) {
        closeAdd();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [adding, closeAdd]);

  const accent = useColor('--color-accent');
  // The header's derived status reads tasks and waits, so a pull re-pulls all
  // three lists this screen shows.
  const refetchAll = useCallback(
    () => Promise.all([api.refetch(), tasksApi.refetch(), waitsApi.refetch()]),
    [api, tasksApi, waitsApi],
  );
  const { refreshing, onRefresh } = usePullRefresh(refetchAll);

  // Still hydrating the collection: hold a blank screen rather than flash a
  // not-found.
  if (projects === undefined) {
    return <View className="flex-1 bg-background" />;
  }

  // A bad or deleted id: offer the way back.
  if (!project) {
    return (
      <View className="flex-1 bg-background">
        <BackRow onBack={back} />
        <Text variant="subtitle" className="px-screen-x">
          This project is no longer here.
        </Text>
      </View>
    );
  }

  const displayStatus = projectDisplayStatus(project, tasks, conds, list);

  return (
    <View
      ref={rootRef}
      onLayout={measureBottomGap}
      className="flex-1 bg-background"
    >
      <BackRow onBack={back} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 96 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={accent}
            colors={[accent]}
          />
        }
      >
        {error ? (
          <Text variant="error" className="px-screen-x pb-2">
            {error}
          </Text>
        ) : null}

        <ProjectHeader
          project={project}
          displayStatus={displayStatus}
          onEdit={commitEdit}
          onStatus={(status) => {
            if (status === 'done') {
              requestProjectLeave(project.id, 'done');
              back();
            } else {
              commitStatus(status);
            }
          }}
          onDelete={() => {
            requestProjectLeave(project.id, 'delete');
            back();
          }}
        />

        {/* The description is the project's statement of intent — why this
            outcome matters. It sits under the title, above the work. */}
        <ProjectDescription project={project} onEdit={commitEdit} />

        <ProjectTasks api={tasksApi} projectId={project.id} onError={setError} />

        <ProjectWaits
          project={project}
          waitsApi={waitsApi}
          tasks={tasks}
          onError={setError}
        />
      </ScrollView>

      {/* Task-only quick-add: no capture mode, so it adds a task to this
          project. */}
      <QuickAdd
        open={adding}
        text={text}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={onAdd}
        onRequestClose={closeAdd}
        busy={false}
        inputRef={inputRef}
        fabLabel="Add a task"
        placeholder="Add a task to this project…"
        bottomOffset={bottomOffset}
      />
    </View>
  );
}

// The identity header: a de-emphasized icon (tap to open the picker sheet), the
// title as an editable heading (commit on blur / submit), a derived-status pill,
// and a "⋯" that opens the status/delete actions sheet.
function ProjectHeader({
  project,
  displayStatus,
  onEdit,
  onStatus,
  onDelete,
}: {
  project: Project;
  displayStatus: ProjectStatus;
  onEdit: (fields: ProjectEditFields) => void;
  onStatus: (status: ProjectStatus) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  // rn-emoji-keyboard owns its own modal, so it is themed by literal colors, not
  // CSS vars — resolve the app tokens the same way the rest of the screen does.
  const emojiTheme = {
    backdrop: useColor('--color-scrim'),
    knob: useColor('--color-divider'),
    container: useColor('--color-surface'),
    header: useColor('--color-foreground'),
    skinTonesContainer: useColor('--color-surface-muted'),
    category: {
      icon: useColor('--color-foreground-muted'),
      iconActive: useColor('--color-accent'),
      container: useColor('--color-surface'),
      containerActive: useColor('--color-surface-muted'),
    },
    search: {
      background: useColor('--color-surface-muted'),
      text: useColor('--color-foreground'),
      placeholder: useColor('--color-placeholder'),
      icon: useColor('--color-foreground-muted'),
    },
    emoji: { selected: useColor('--color-surface-muted') },
  };

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed === '' || trimmed === project.title) {
      setTitle(project.title);
      return;
    }
    onEdit({ title: trimmed });
  };

  return (
    <View className="px-screen-x pb-4">
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change icon"
          hitSlop={8}
          onPress={() => setPickingIcon(true)}
        >
          <Text className="text-[30px]">{project.icon}</Text>
        </Pressable>
        <Input
          value={title}
          onChangeText={setTitle}
          onBlur={commitTitle}
          onSubmitEditing={commitTitle}
          returnKeyType="done"
          blurOnSubmit
          accessibilityLabel="Project title"
          className="flex-1 text-[22px] font-bold"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Project actions"
          hitSlop={8}
          onPress={() => setActionsOpen(true)}
        >
          <Text className="text-[22px] text-foreground-muted">⋯</Text>
        </Pressable>
      </View>
      <View className="mt-2 flex-row">
        <View className="rounded-full bg-surface-muted px-2.5 py-0.5">
          <Text className="text-[12px] text-foreground-muted">
            {STATUS_LABELS[displayStatus]}
          </Text>
        </View>
      </View>

      {/* The full emoji picker owns its own modal (search over every standard
          emoji), so it is not an @expo/ui sheet. */}
      <EmojiPicker
        open={pickingIcon}
        onClose={() => setPickingIcon(false)}
        enableSearchBar
        enableRecentlyUsed={false}
        // The picker is a bottom-anchored modal that does not lift for the
        // on-screen keyboard, and focusing the search bar does not expand it. At
        // the default 40% height the keyboard covers the whole sheet, hiding the
        // search field and its results. A tall fixed sheet keeps the search bar
        // (rendered at the top) and the matching emoji above the keyboard.
        defaultHeight="85%"
        expandable={false}
        theme={emojiTheme}
        onEmojiSelected={(picked: EmojiType) => {
          if (picked.emoji !== project.icon) onEdit({ icon: picked.emoji });
          setPickingIcon(false);
        }}
      />

      <Sheet open={actionsOpen} onClose={() => setActionsOpen(false)}>
        <Column spacing={8}>
          {project.status === 'backlog' ? (
            <Button
              variant="outlined"
              label="Put in play"
              onPress={() => {
                setActionsOpen(false);
                onStatus('next');
              }}
            />
          ) : (
            <Button
              variant="outlined"
              label="Move to backlog"
              onPress={() => {
                setActionsOpen(false);
                onStatus('backlog');
              }}
            />
          )}
          <Button
            variant="outlined"
            label="Mark done"
            onPress={() => {
              setActionsOpen(false);
              onStatus('done');
            }}
          />
          <Button
            variant="text"
            label="Delete project"
            onPress={() => {
              setActionsOpen(false);
              onDelete();
            }}
          />
        </Column>
      </Sheet>
    </View>
  );
}

// The project's tasks, groomed in place: complete one with its circle, take it
// on / park it with the star, add a new one (parked by default — grooming is
// collect-then-take-on). Plain RN rows, like the list screens.
function ProjectTasks({
  api,
  projectId,
  onError,
}: {
  api: TasksApi;
  projectId: string;
  onError: (message: string) => void;
}) {
  const { data: tasks } = useLiveQuery((q) =>
    q
      .from({ t: api.collection })
      .where(({ t }) => isNull(t.completedAt))
      .orderBy(({ t }) => t.createdAt, 'asc'),
  );
  const list = (tasks ?? []).filter((t: Task) => t.projectId === projectId);

  const onComplete = (tid: string) => {
    const tx = api.complete(tid);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };

  const onToggleTakenOn = (t: Task) => {
    const tx = t.takenOnAt ? api.park(t.id) : api.takeOn(t.id);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };

  return (
    <View className="px-screen-x pb-4">
      <Text variant="section" className="pb-2">
        Tasks
      </Text>
      {list.map((t) => (
        <View key={t.id} className="flex-row items-center gap-3 py-2">
          <CheckCircle label={`Complete "${t.text}"`} onPress={() => onComplete(t.id)} />
          <Text className="flex-1">{t.text}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.takenOnAt ? `Park "${t.text}"` : `Take on "${t.text}"`}
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
    </View>
  );
}

// A human label for a waiting condition.
function conditionLabel(c: WaitingCondition, tasks: Task[], projects: Project[]): string {
  if (c.kind === 'free-text') return c.text ?? '(unspecified)';
  if (c.kind === 'task-done') {
    const t = tasks.find((x) => x.id === c.refId);
    return `until “${t?.text ?? '?'}” is done`;
  }
  const p = projects.find((x) => x.id === c.refId);
  return `until “${p?.title ?? '?'}” is ${c.targetStatus}`;
}

// The waiting conditions for a project: the open ones (resolve/delete) and a
// free-text add. Structured kinds (task-done, project-status) are created on web
// for now; here they still render with a label and auto-resolve in code.
function ProjectWaits({
  project,
  waitsApi,
  tasks,
  onError,
}: {
  project: Project;
  waitsApi: WaitsApi;
  tasks: Task[];
  onError: (message: string) => void;
}) {
  const { data: allConditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const list = (allConditions ?? []).filter(
    (c: WaitingCondition) => c.projectId === project.id,
  );
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
    <View className="px-screen-x pb-4">
      <Text variant="section" className="pb-2">
        Waiting on
      </Text>
      {list.map((c) => (
        <View key={c.id} className="flex-row items-center gap-2 py-2">
          <Text className="flex-1 text-[14px]">{conditionLabel(c, tasks, [project])}</Text>
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
      <View className="mt-1 rounded-xl bg-surface-muted px-4 py-3">
        <Input
          value={text}
          onChangeText={setText}
          onSubmitEditing={onAdd}
          returnKeyType="done"
          blurOnSubmit={false}
          placeholder="Waiting on… (e.g. the letter comes back)"
          accessibilityLabel="Waiting condition"
        />
      </View>
    </View>
  );
}

// The project's description: its statement of intent, an always-visible editable
// field under the title (above the work). Commits on blur; can be cleared to
// null.
function ProjectDescription({
  project,
  onEdit,
}: {
  project: Project;
  onEdit: (fields: ProjectEditFields) => void;
}) {
  const [description, setDescription] = useState(project.description ?? '');

  const commit = () => {
    const next = description.trim() === '' ? null : description;
    if ((next ?? null) === (project.description ?? null)) return;
    onEdit({ description: next });
  };

  return (
    <View className="px-screen-x pb-4">
      <Input
        value={description}
        onChangeText={setDescription}
        onBlur={commit}
        multiline
        placeholder="What outcome are you after, and why does it matter?"
        accessibilityLabel="Project description"
        className="text-[15px] text-foreground-muted"
      />
    </View>
  );
}
