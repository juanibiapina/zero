import { Button, Column } from '@expo/ui';
import { useAuth } from '@clerk/expo';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  dayLabel,
  isBasisStale,
  localToday,
  messageOf,
  projectDisplayStatus,
  STATUS_LABELS,
  waitingUntil,
  type Project,
  type ProjectEditFields,
  type ProjectStatus,
  type ProjectsApi,
  type Task,
  type TasksApi,
  type WaitingCondition,
  type WaitsApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BackHandler,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmojiKeyboard, type EmojiType } from 'rn-emoji-keyboard';
import { CheckCircle } from '@/components/ui/list-row';
import { Input } from '@/components/ui/input';
import { useQuickAdd } from '@/components/quick-add-composer';
import { useTaskDetail } from '@/components/task-detail';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import {
  requestIconSuggestions,
  useIconSuggestions,
} from '@/lib/icon-suggestions';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useWaitsApi } from '@/lib/waits-collection';
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
  const { getToken } = useAuth();
  const back = useCallback(() => router.back(), [router]);
  const [error, setError] = useState<string | null>(null);

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

  const commitDelete = useCallback(() => {
    if (!project) return;
    setError(null);
    // The write lives on the shared projects data layer, not this screen, so it
    // persists even though we pop away immediately — no toast, no deferred window.
    // The server cascades the delete to the project's tasks and waiting
    // conditions, so once it persists we re-pull those two collections to drop
    // any lingering orphan (a future-dated task of this project would otherwise
    // sit in Upcoming until the next refetch — Upcoming applies no project gate).
    const tx = api.remove(project.id);
    tx.isPersisted.promise
      .then(() => Promise.all([tasksApi.refetch(), waitsApi.refetch()]))
      .catch((e) => setError(messageOf(e)));
  }, [api, tasksApi, waitsApi, project]);

  // This project's open tasks, the list the shared task editor resolves against:
  // moving a task to another project drops it here (closes the sheet), while a
  // reschedule keeps it (this screen shows the project's tasks regardless of
  // date). Same membership as the ProjectTasks section below.
  const projectTasks = useMemo(
    () => (openTasks ?? []).filter((t) => t.projectId === id),
    [openTasks, id],
  );

  // The task detail editor — the same one Home and Upcoming open. Tapping a task
  // row opens it; its circle completes with the shared Undo.
  const detail = useTaskDetail({
    api: tasksApi,
    list: projectTasks,
    projects: list,
    onError: setError,
  });

  // The quick-add composer, project-scoped: Task and Waiting modes, the project
  // fixed to this one (no project chip), and — like Home — a create-time date
  // chip on a task. See quick-add-composer.tsx.
  const add = useQuickAdd({
    tasksApi,
    projectsApi: api,
    waitsApi,
    projects: list,
    modes: ['task', 'waiting'],
    projectId: id,
    getToken,
    onError: setError,
    fabLabel: 'Add',
  });

  // Android hardware Back: close an open editor sheet, then the quick-add, before
  // it pops the screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail.handleBack()) return true;
      if (add.handleBack()) return true;
      return false;
    });
    return () => sub.remove();
  }, [detail, add]);

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

  const today = localToday();
  const displayStatus = projectDisplayStatus(project, tasks, today, conds, list);

  return (
    <View className="flex-1 bg-background">
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
              // Marking done removes the project from the working list; commit
              // immediately and pop back to it.
              commitStatus(status);
              back();
            } else {
              commitStatus(status);
            }
          }}
          onDelete={() => {
            commitDelete();
            back();
          }}
        />

        {/* The description is the project's statement of intent — why this
            outcome matters. It sits under the title, above the work. */}
        <ProjectDescription project={project} onEdit={commitEdit} />

        <ProjectTasks
          api={tasksApi}
          projectId={project.id}
          onOpen={detail.open}
          onComplete={detail.complete}
        />

        <ProjectWaits
          project={project}
          waitsApi={waitsApi}
          tasks={tasks}
          today={today}
          onError={setError}
        />
      </ScrollView>

      {detail.sheets}

      {/* Project-scoped quick-add: Task and Waiting pills, the project fixed to
          this one, plus a create-time date chip on a task — the same composer
          Home uses. */}
      {add.bar}
    </View>
  );
}

// One combined icon-picker surface, mirroring the web popover: the pre-warmed AI
// suggestions on top, the full searchable emoji grid directly below, in a single
// bottom sheet — no extra hop. It is a plain RN bottom sheet (a Modal + backdrop
// + a tall bottom-anchored panel), NOT an @expo/ui native sheet, because it hosts
// the raw-RN `EmojiKeyboard` (the inline, non-modal build of rn-emoji-keyboard);
// hosting RN rows inside the @expo/ui native tree is the very bug this screen
// avoids. The panel is fixed at 85% height so the keyboard's search bar (rendered
// at the top with categoryPosition="top") stays above the on-screen keyboard.
function IconPickerSheet({
  project,
  open,
  onClose,
  onPick,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
}) {
  const { getToken } = useAuth();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // The pre-warmed AI suggestions. Opening the sheet is the fetch-on-open
  // fallback: a cache miss (a different device, an eviction, an offline creation)
  // fetches now; a warmed cache shows instantly.
  const basis = useMemo(
    () => ({ title: project.title, description: project.description }),
    [project.title, project.description],
  );
  const cached = useIconSuggestions(project.id);
  useEffect(() => {
    if (open) void requestIconSuggestions(getToken, project.id, basis);
  }, [open, getToken, project.id, basis]);
  const loading = !cached || cached.status === 'loading';
  const icons = cached?.icons ?? [];
  const stale =
    !!cached && cached.status === 'ready' && isBasisStale(cached.basis, basis);
  const refresh = () =>
    void requestIconSuggestions(getToken, project.id, basis, { force: true });

  // rn-emoji-keyboard is themed by literal colors, not CSS vars — resolve the app
  // tokens the same way the rest of the screen does.
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

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close icon picker"
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <View
        style={{ height: Math.round(height * 0.85), paddingBottom: insets.bottom }}
        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface"
      >
        {/* Suggested row on top — additive over the full grid below. */}
        <View className="flex-row flex-wrap items-center gap-2 px-4 pt-3 pb-2">
          <Text className="text-[12px] font-medium text-foreground-muted">
            Suggested
          </Text>
          {loading ? (
            <Text className="text-foreground-muted">Loading suggested icons…</Text>
          ) : icons.length > 0 ? (
            icons.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={`Use suggested icon ${emoji}`}
                hitSlop={6}
                onPress={() => onPick(emoji)}
                className="rounded-md px-1.5 py-1"
              >
                <Text className="text-[22px]">{emoji}</Text>
              </Pressable>
            ))
          ) : (
            <Text className="text-foreground-muted">
              Couldn&apos;t load suggestions
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh suggested icons"
            hitSlop={8}
            onPress={refresh}
            className="ml-auto rounded-md px-2 py-1"
          >
            <Text
              className={
                stale
                  ? 'text-[16px] text-foreground'
                  : 'text-[16px] text-foreground-muted'
              }
            >
              ↻
            </Text>
          </Pressable>
        </View>
        <View className="h-px bg-divider" />
        {/* The full searchable picker, inline (not its own modal), filling the
            rest of the sheet. */}
        <View className="flex-1">
          <EmojiKeyboard
            onEmojiSelected={(picked: EmojiType) => onPick(picked.emoji)}
            enableSearchBar
            enableRecentlyUsed={false}
            theme={emojiTheme}
          />
        </View>
      </View>
    </Modal>
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed === '' || trimmed === project.title) {
      setTitle(project.title);
      return;
    }
    onEdit({ title: trimmed });
  };

  // Apply an icon (a suggestion chip or the manual grid) and close the picker.
  // A no-op edit is skipped.
  const applyIcon = (emoji: string) => {
    if (emoji !== project.icon) onEdit({ icon: emoji });
    setPickerOpen(false);
  };

  return (
    <View className="px-screen-x pb-4">
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change icon"
          hitSlop={8}
          onPress={() => setPickerOpen(true)}
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

      {/* One combined surface: AI suggestions on top, the full searchable emoji
          grid below — mirroring the web popover, no second tap. */}
      <IconPickerSheet
        project={project}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={applyIcon}
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

// The project's tasks: complete one with its circle, or tap its text to open the
// full task editor — the same one Home and Upcoming open — where you rename,
// schedule (dating a task commits it to Home), move it, or complete it. Plain RN
// rows, like the list screens. Scheduling lives in the editor now (there is no
// inline per-row date chip), so the row reads exactly like every other list row.
function ProjectTasks({
  api,
  projectId,
  onOpen,
  onComplete,
}: {
  api: TasksApi;
  projectId: string;
  // Open the shared task editor for a task (owned by the screen's useTaskDetail).
  onOpen: (task: Task) => void;
  // Complete a task with the shared single Undo snackbar (owned by the same hook).
  onComplete: (task: Task) => void;
}) {
  const { data: tasks } = useLiveQuery((q) =>
    q
      .from({ t: api.collection })
      .where(({ t }) => isNull(t.completedAt))
      .orderBy(({ t }) => t.createdAt, 'asc'),
  );
  const list = (tasks ?? []).filter((t: Task) => t.projectId === projectId);

  // Nothing here yet: render no section at all (not a bare heading). Adding is
  // the screen's plus FAB, so hiding this removes no add path. The live query
  // above still runs, so the section appears the instant the first task lands.
  if (list.length === 0) return null;

  return (
    <View className="px-screen-x pb-4">
      <Text variant="section" className="pb-2">
        Tasks
      </Text>
      {list.map((t) => (
        <View key={t.id} className="flex-row items-center gap-3 py-2">
          <CheckCircle
            label={`Complete "${t.text}"`}
            onPress={() => onComplete(t)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Edit "${t.text}"`}
            className="flex-1"
            onPress={() => onOpen(t)}
          >
            <Text>{t.text}</Text>
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

// The waiting conditions for a project: the open ones (resolve/delete). Adding a
// condition moved to the screen's plus FAB (the Waiting mode), so this section is
// list-only. Structured kinds (task-done, project-status) are created on web for
// now; here they still render with a label and auto-resolve in code.
function ProjectWaits({
  project,
  waitsApi,
  tasks,
  today,
  onError,
}: {
  project: Project;
  waitsApi: WaitsApi;
  tasks: Task[];
  today: string;
  onError: (message: string) => void;
}) {
  const { data: allConditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const list = (allConditions ?? []).filter(
    (c: WaitingCondition) => c.projectId === project.id,
  );
  // A future-dated taken-on task makes the project wait until that day, derived
  // with no stored row — shown as an automatic reason (no Resolve/delete).
  const until = waitingUntil(project, tasks, today);

  const write = (tx: { isPersisted: { promise: Promise<unknown> } }) => {
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };

  // Nothing to show: no open conditions and no derived date wait. Render no
  // section at all (not a bare heading). Adding a condition is the screen's plus
  // FAB (Waiting mode), so hiding this removes no add path.
  if (list.length === 0 && until == null) return null;

  return (
    <View className="px-screen-x pb-4">
      <Text variant="section" className="pb-2">
        Waiting on
      </Text>
      {until != null && (
        <View className="flex-row items-center gap-2 py-2">
          <Text className="flex-1 text-[14px]">until {dayLabel(until, today)}</Text>
          <Text className="text-[12px] text-foreground-muted">auto</Text>
        </View>
      )}
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
