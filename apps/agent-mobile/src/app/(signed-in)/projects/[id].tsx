import { Column, ListItem, Text as UIText } from '@expo/ui';
import { MenuView } from '@expo/ui/community/menu';
import { useAuth } from '@clerk/expo';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  candidatePrerequisiteProjects,
  compareByOrder,
  isBasisStale,
  isProjectCompletionDependency,
  localToday,
  messageOf,
  projectDependencies,
  projectDependencyRemovalImpact,
  projectDependencyRemovalWarning,
  projectDisplayStatus,
  projectStatusContext,
  scheduleLabel,
  PROJECT_DISPLAY_STATUS_LABELS,
  toast,
  type Project,
  type ProjectEditFields,
  type ProjectState,
  type ProjectsApi,
  type Task,
  type TasksApi,
  type WaitingCondition,
  type WaitsApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  BackHandler,
  Modal,
  Pressable,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmojiKeyboard, type EmojiType } from 'rn-emoji-keyboard';
import { Input } from '@/components/ui/input';
import { useQuickAdd } from '@/components/quick-add-composer';
import { ReorderableTaskList } from '@/components/reorderable-task-list';
import { ProjectPickerSheet, useTaskDetail } from '@/components/task-detail';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import {
  requestIconSuggestions,
  useIconSuggestions,
} from '@/lib/icon-suggestions';
import { useProjectsApi } from '@/lib/projects-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useWaitsApi } from '@/lib/waits-collection';
import { useForegroundRefetch, usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

// A project's own screen (pushed within the Projects tab). This is a plain React
// Native view tree — NOT an @expo/ui native tree — so its task and waiting rows
// render like every other list screen. (The old bottom-sheet detail dropped raw
// RN rows inside an @expo/ui Column, which the native host cannot lay out; that
// is the bug this screen removes.) Status uses a short @expo/ui sheet, settings
// uses a native menu, and the emoji picker is a plain RN modal for its RN grid.
// See docs/plans/todo-project-detail-rework.md.
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

function reportProjectFailure(message: string, description: string) {
  toast(message, {
    id: 'project-error', description, durationMs: Infinity,
    action: { label: 'Dismiss', onPress: () => toast.dismiss('project-error') },
  });
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
  const [pickingDependency, setPickingDependency] = useState(false);

  const { data: projects } = useLiveQuery((q) =>
    q.from({ p: api.collection }).orderBy(({ p }) => p.createdAt, 'asc'),
  );
  const { data: openTasks } = useLiveQuery((q) =>
    q.from({ t: tasksApi.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );

  const list = useMemo(() => projects ?? [], [projects]);
  const tasks = useMemo(() => openTasks ?? [], [openTasks]);
  const conds = useMemo(() => conditions ?? [], [conditions]);
  const project = list.find((p) => p.id === id) ?? null;
  const dependencyCandidates = useMemo(
    () => candidatePrerequisiteProjects(id, list, conds),
    [id, list, conds],
  );

  const commitEdit = useCallback(
    (fields: ProjectEditFields) => {
      if (!project) return;
      setError(null);
      const tx = api.edit(project.id, fields);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
    },
    [api, project],
  );

  const commitState = useCallback(
    (state: ProjectState) => {
      if (!project) return;
      setError(null);
      const failed = (e: unknown) => state === 'done'
        ? reportProjectFailure('Could not mark project done', `“${project.title}”: open Projects, refresh, and try again.`)
        : setError(messageOf(e));
      try {
        const tx = api.setState(project.id, state);
        void tx.isPersisted.promise.then(
          () => (state === 'done' ? waitsApi.refetch() : undefined),
          failed,
        ).catch(() =>
          reportProjectFailure(
            'Project done; dependencies could not refresh',
            'Open Projects and pull to refresh when you are connected.',
          ),
        );
      } catch (e) { failed(e); }
    },
    [api, project, waitsApi],
  );

  const commitDependency = useCallback(
    (prerequisiteProjectId: string | null) => {
      setPickingDependency(false);
      if (!project || prerequisiteProjectId == null) return;
      setError(null);
      const tx = waitsApi.dependOnProject(
        project.id,
        prerequisiteProjectId,
      );
      tx.isPersisted.promise.catch((cause) => setError(messageOf(cause)));
    },
    [project, waitsApi],
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
    const failed = () => reportProjectFailure(
      'Could not delete project', `“${project.title}”: open Projects, refresh, and try again.`,
    );
    try {
      const tx = api.remove(project.id);
      void tx.isPersisted.promise.then(async () => {
        try {
          await Promise.all([tasksApi.refetch(), waitsApi.refetch()]);
          if (tasksApi.getLoadError() || waitsApi.getLoadError()) throw new Error('refresh');
        } catch {
          reportProjectFailure('Project deleted; lists could not refresh', 'Pull to refresh when you are connected.');
        }
      }, failed);
    } catch { failed(); }
  }, [api, tasksApi, waitsApi, project]);

  // This project's open tasks, the list the shared task editor resolves against:
  // moving a task to another project drops it here (closes the sheet), while a
  // reschedule keeps it (this screen shows the project's tasks regardless of
  // date). The shared reorderable list and task editor consume this same array.
  const projectTasks = useMemo(
    () =>
      (openTasks ?? [])
        .filter((task) => task.projectId === id)
        .sort(compareByOrder),
    [openTasks, id],
  );

  // The task detail editor — the same one Home and Upcoming open. Tapping a task
  // row opens it; its circle completes with the shared Undo.
  const detail = useTaskDetail({
    api: tasksApi,
    list: projectTasks,
    projects: list,
    currentProjectId: id,
    onError: setError,
  });

  // The quick-add composer offers Task, Waiting, and Project. Task stays first
  // so every open defaults to adding work under this project; Waiting remains
  // scoped here, and Project reuses the ordinary independent-project path.
  const add = useQuickAdd({
    tasksApi,
    projectsApi: api,
    waitsApi,
    projects: list,
    modes: ['task', 'waiting', 'project'],
    projectId: id,
    getToken,
    onError: setError,
    fabLabel: 'Add',
  });

  // Android hardware Back: close an open editor sheet, then the quick-add, before
  // it pops the screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pickingDependency) {
        setPickingDependency(false);
        return true;
      }
      if (detail.handleBack()) return true;
      if (add.handleBack()) return true;
      return false;
    });
    return () => sub.remove();
  }, [detail, add, pickingDependency]);

  // The header's derived status reads tasks and waits, so a pull re-pulls all
  // three lists this screen shows.
  const refetchAll = useCallback(async () => {
    await Promise.all([api.refetch(), tasksApi.refetch(), waitsApi.refetch()]);
  }, [api, tasksApi, waitsApi]);
  useForegroundRefetch(refetchAll);
  const { refreshing, onRefresh } = usePullRefresh(refetchAll);
  const today = localToday();
  const presentationOf = useCallback(
    (task: Task) => {
      const scheduled =
        task.showUpDate == null
          ? null
          : scheduleLabel(task.showUpDate, today);
      return {
        caption: scheduled ? `Scheduled · ${scheduled}` : null,
        accessibilityLabel: `Edit "${task.text}"${
          scheduled ? `, scheduled ${scheduled}` : ''
        }`,
      };
    },
    [today],
  );

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

  const displayStatus = projectDisplayStatus(project, tasks, today, conds, list);
  const statusContext = projectStatusContext(
    project,
    tasks,
    conds,
    list,
    today,
  )?.label;
  const statusLabel = `${PROJECT_DISPLAY_STATUS_LABELS[displayStatus]}${
    statusContext ? ` · ${statusContext}` : ''
  }`;

  return (
    <View className="flex-1 bg-background">
      <BackRow onBack={back} />
      <ReorderableTaskList
        api={tasksApi}
        tasks={projectTasks}
        today={today}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onComplete={detail.complete}
        onOpen={detail.open}
        onError={setError}
        presentationOf={presentationOf}
        postponeMode="return"
        keyboardShouldPersistTaps="handled"
        header={
          <>
            {error ? (
              <Text variant="error" className="px-screen-x pb-2">
                {error}
              </Text>
            ) : null}

            <ProjectHeader
              project={project}
              statusLabel={statusLabel}
              deletionWarning={projectDependencyRemovalWarning(
                projectDependencyRemovalImpact(project.id, conds, list),
              )}
              onDepend={() => setPickingDependency(true)}
              onEdit={commitEdit}
              onState={(state) => {
                if (state === 'done') {
                  // Marking done removes the project from the working list;
                  // commit immediately and pop back to it.
                  commitState(state);
                  back();
                } else {
                  commitState(state);
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

            {projectTasks.length > 0 ? (
              <Text variant="section" className="px-screen-x pb-2">
                Tasks
              </Text>
            ) : null}
          </>
        }
        footer={
          <ProjectWaits
            project={project}
            waitsApi={waitsApi}
            tasks={tasks}
            projects={list}
            onError={setError}
          />
        }
      />

      {detail.sheets}

      <ProjectPickerSheet
        open={pickingDependency}
        title="Depends on"
        projects={dependencyCandidates}
        selectedProjectId={null}
        showNoProject={false}
        emptyCopy="No available projects"
        onPick={commitDependency}
        onClose={() => setPickingDependency(false)}
      />

      {/* Project quick-add: Task, Waiting, and Project tabs, with task metadata
          preset to this project and Waiting scoped to it. */}
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
// title as an editable heading (commit on blur / submit), a tappable derived-
// status pill, and a "⋯" reserved for project settings.
function ProjectHeader({
  project,
  statusLabel,
  deletionWarning,
  onDepend,
  onEdit,
  onState,
  onDelete,
}: {
  project: Project;
  statusLabel: string;
  deletionWarning: string | null;
  onDepend: () => void;
  onEdit: (fields: ProjectEditFields) => void;
  onState: (state: ProjectState) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const foreground = useColor('--color-foreground');
  const secondary = useColor('--color-foreground-secondary');
  const danger = useColor('--color-danger');
  const ripple = useColor('--color-ripple');

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

  const chooseState = (state: ProjectState) => {
    setStatusOpen(false);
    onState(state);
  };
  const chooseDependency = () => {
    setStatusOpen(false);
    requestAnimationFrame(onDepend);
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
        <MenuView
          title="Project settings"
          actions={[
            {
              id: 'delete',
              title: 'Delete project',
              titleColor: danger,
              attributes: { destructive: true },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === 'delete') {
              Alert.alert(
                `Delete “${project.title}”?`,
                `This permanently deletes the project, all its tasks (including completed tasks), and its waiting conditions. This cannot be undone.${deletionWarning ? ` ${deletionWarning}` : ''}`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: onDelete },
                ],
                { cancelable: true },
              );
            }
          }}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel="Project settings"
            className="p-2"
          >
            <Text className="text-[22px] text-foreground-muted">⋯</Text>
          </View>
        </MenuView>
      </View>
      <View className="mt-2 flex-row">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Project status: ${statusLabel}`}
          accessibilityHint="Change project status or dependencies"
          hitSlop={8}
          android_ripple={{ color: ripple }}
          onPress={() => setStatusOpen(true)}
          className="max-w-full flex-row items-center gap-2 overflow-hidden rounded-full bg-surface-muted px-3 py-1.5"
        >
          <Text
            numberOfLines={1}
            className="text-[13px] font-medium text-foreground-secondary"
          >
            {statusLabel}
          </Text>
          <Text importantForAccessibility="no" className="text-foreground-secondary">▾</Text>
        </Pressable>
      </View>

      {/* One combined surface: AI suggestions on top, the full searchable emoji
          grid below — mirroring the web popover, no second tap. */}
      <IconPickerSheet
        project={project}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={applyIcon}
      />

      <Sheet
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        contentPadding={{ top: 8, bottom: 16, left: 0, right: 0 }}
      >
        <Column>
          <Column
            spacing={2}
            style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 8 }}
          >
            <UIText
              textStyle={{ color: foreground, fontSize: 20, fontWeight: '600' }}
            >
              Project status
            </UIText>
            <UIText textStyle={{ color: secondary, fontSize: 14 }}>
              {statusLabel}
            </UIText>
          </Column>
          {project.state === 'backlog' ? (
            <ListItem onPress={() => chooseState('in-play')}>
              <UIText textStyle={{ color: foreground, fontSize: 16 }}>
                Move out of backlog
              </UIText>
            </ListItem>
          ) : (
            <ListItem onPress={() => chooseState('backlog')}>
              <UIText textStyle={{ color: foreground, fontSize: 16 }}>
                Move to backlog
              </UIText>
            </ListItem>
          )}
          <ListItem onPress={chooseDependency}>
            <UIText textStyle={{ color: foreground, fontSize: 16 }}>
              Depends on project…
            </UIText>
          </ListItem>
          <ListItem onPress={() => chooseState('done')}>
            <UIText textStyle={{ color: foreground, fontSize: 16 }}>
              Mark done
            </UIText>
          </ListItem>
        </Column>
      </Sheet>
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

// Completion dependencies render as navigable Project identities under Depends
// on. Every other stored condition remains under Waiting on. A future task date
// is explained by the status pill and source task instead of another row.
function ProjectWaits({
  project,
  waitsApi,
  tasks,
  projects,
  onError,
}: {
  project: Project;
  waitsApi: WaitsApi;
  tasks: Task[];
  projects: Project[];
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const { data: allConditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const dependencies = projectDependencies(
    project.id,
    allConditions ?? [],
    projects,
  );
  const list = (allConditions ?? []).filter(
    (condition: WaitingCondition) =>
      condition.projectId === project.id &&
      !isProjectCompletionDependency(condition),
  );
  const write = (tx: { isPersisted: { promise: Promise<unknown> } }) => {
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };

  if (list.length === 0 && dependencies.length === 0) return null;

  return (
    <View className="pb-4">
      {dependencies.length > 0 ? (
        <View className="pb-3">
          <Text variant="section" className="px-screen-x pb-2">
            Depends on
          </Text>
          {dependencies.map(({ condition, prerequisite }) => (
            <View
              key={condition.id}
              className="flex-row items-stretch border-b border-divider"
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open project ${prerequisite?.title ?? 'prerequisite'}`}
                disabled={!prerequisite}
                className="min-h-14 flex-1 flex-row items-center gap-3 px-screen-x py-2"
                onPress={() => {
                  if (prerequisite) router.push(`/projects/${prerequisite.id}`);
                }}
              >
                <Text className="w-6 text-center text-[18px]">
                  {prerequisite?.icon ?? '📁'}
                </Text>
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-[15px] font-medium">
                    {prerequisite?.title ?? 'Another project'}
                  </Text>
                  <Text variant="caption">Must be completed first</Text>
                </View>
                <Text importantForAccessibility="no" className="text-foreground-muted">
                  ›
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove dependency on ${prerequisite?.title ?? 'project'}`}
                className="min-h-14 min-w-16 items-center justify-center px-2"
                onPress={() => write(waitsApi.remove(condition.id))}
              >
                <Text className="text-[13px] font-semibold text-accent">Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {list.length > 0 ? (
        <View className="px-screen-x">
          <Text variant="section" className="pb-2">
            Waiting on
          </Text>
          {list.map((condition) => {
            const label = conditionLabel(condition, tasks, projects);
            return (
              <View key={condition.id} className="flex-row items-center gap-2 py-2">
                <Text className="flex-1 text-[14px]">{label}</Text>
                {condition.kind === 'free-text' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Resolve condition: ${label}`}
                    className="min-h-12 min-w-12 items-center justify-center"
                    hitSlop={8}
                    onPress={() => write(waitsApi.resolve(condition.id))}
                  >
                    <Text className="text-[13px] font-semibold text-accent">Resolve</Text>
                  </Pressable>
                ) : (
                  <Text className="text-[12px] text-foreground-muted">auto</Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete condition: ${label}`}
                  className="min-h-12 min-w-12 items-center justify-center"
                  hitSlop={8}
                  onPress={() => write(waitsApi.remove(condition.id))}
                >
                  <Text className="text-[16px] text-foreground-muted">✕</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
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
        placeholderTextColorClassName="text-foreground-secondary"
        className="text-[15px] text-foreground-secondary"
      />
    </View>
  );
}
