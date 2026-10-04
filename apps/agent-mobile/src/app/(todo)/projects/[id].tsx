import { Column, Host, Icon, ListItem, Text as UIText } from '@expo/ui';
import { MenuView } from '@expo/ui/community/menu';
import { useAuth } from '@clerk/expo';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  compareByOrder,
  isBasisStale,
  isProjectAfter,
  messageOf,
  projectAfters,
  projectAfterRemovalImpact,
  projectAfterRemovalWarning,
  projectDisplayStatus,
  projectStatusContext,
  scheduleLabel,
  PROJECT_DISPLAY_STATUS_LABELS,
  toast,
  undoableAction,
  type Project,
  type ProjectEditFields,
  type ProjectState,
  type TodoProjects,
  type Task,
  type TaskdoReplica,
  type WaitingCondition,
  type TodoWaits,
} from '@zero/agent-core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
import { useProjectAdd } from '@/components/project-add';
import { ReorderableTaskList } from '@/components/reorderable-task-list';
import { useTaskDetail } from '@/components/task-detail';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import {
  requestIconSuggestions,
  useIconSuggestions,
} from '@/lib/icon-suggestions';
import { useLocalDay } from '@/lib/local-day';
import { useTodoReplica } from '@/lib/todo-replica-hook';
import { useTodoDataContext } from '@/lib/todo-data-context';
import { usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

const ADD_ICON = Icon.select({
  ios: 'plus',
  android: import('@expo/material-symbols/add.xml'),
});
const REMOVE_ICON = Icon.select({
  ios: 'xmark',
  android: import('@expo/material-symbols/close_small.xml'),
});
const STATUS_DISCLOSURE_ICON = Icon.select({
  ios: 'chevron.down',
  android: import('@expo/material-symbols/keyboard_arrow_down.xml'),
});
const ROW_DISCLOSURE_ICON = Icon.select({
  ios: 'chevron.right',
  android: import('@expo/material-symbols/chevron_right.xml'),
});

// A project's own screen (pushed within the Projects tab). React Native owns the
// layout while @expo/ui supplies leaf icons and the short status sheet. Identity,
// dominant status, description, manual Waiting, After relationships, and Tasks
// are sibling regions in that order. Text creation and Project pickers use the
// shared React Native add drawer.
// See docs/entities/project.md.
export default function ProjectDetailScreen() {
  const replica = useTodoReplica();
  return replica ? (
    <ProjectDetail replica={replica} />
  ) : (
    <View className="flex-1 bg-background" />
  );
}

function reportProjectFailure(message: string) {
  toast(message, {
    id: 'project-error', durationMs: Infinity,
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

type CommitProjectEdit = (
  fields: ProjectEditFields,
) => ReturnType<TodoProjects['edit']> | null;

function normalizeDescription(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null;
  return value;
}

type ProjectDraft = { title: string; description: string };
type ProjectDraftValues = { title: string; description: string | null };

function useProjectDraft(
  project: Project | null,
  commitEdit: CommitProjectEdit,
) {
  const projectId = project?.id ?? null;
  const [drafts, setDrafts] = useState<Record<string, Partial<ProjectDraft>>>({});
  const edited = projectId ? drafts[projectId] : undefined;
  const draft = {
    title: edited?.title ?? project?.title ?? '',
    description: edited?.description ?? project?.description ?? '',
  };
  const queuedRef = useRef<{
    projectId: string;
    value: ProjectDraftValues;
    revision: number;
  } | null>(null);
  const revisionRef = useRef(0);
  const commitEditRef = useRef(commitEdit);
  const latestRef = useRef<{
    projectId: string;
    draft: ProjectDraft;
    stored: ProjectDraftValues;
  } | null>(null);

  useLayoutEffect(() => {
    if (!project) return;
    commitEditRef.current = commitEdit;
    latestRef.current = {
      projectId: project.id,
      draft,
      stored: { title: project.title, description: normalizeDescription(project.description) },
    };
    if (queuedRef.current?.projectId !== project.id) queuedRef.current = null;
  }, [commitEdit, project, draft]);

  const onChange = useCallback(
    (field: keyof ProjectDraft, next: string) => {
      const latest = latestRef.current;
      if (!projectId || latest?.projectId !== projectId) return;
      const nextDraft = { ...latest.draft, [field]: next };
      latestRef.current = { ...latest, draft: nextDraft };
      setDrafts((current) => ({
        ...current, [projectId]: { ...current[projectId], [field]: next },
      }));
    },
    [projectId],
  );

  const flush = useCallback(() => {
    const latest = latestRef.current;
    if (!latest) return;
    const queued = queuedRef.current;
    const baseline =
      queued?.projectId === latest.projectId ? queued.value : latest.stored;
    const next = {
      title: latest.draft.title.trim() || baseline.title,
      description: normalizeDescription(latest.draft.description),
    };
    if (latest.draft.title !== next.title) {
      const nextDraft = { ...latest.draft, title: next.title };
      latestRef.current = { ...latest, draft: nextDraft };
      setDrafts((current) => ({
        ...current, [latest.projectId]: { ...current[latest.projectId], title: next.title },
      }));
    }
    const fields: ProjectEditFields = {};
    if (next.title !== baseline.title) fields.title = next.title;
    if (next.description !== baseline.description) fields.description = next.description;
    if (Object.keys(fields).length === 0) return;

    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    queuedRef.current = { projectId: latest.projectId, value: next, revision };
    const tx = commitEditRef.current(fields);
    if (!tx) {
      queuedRef.current = null;
      return;
    }
    void tx.isPersisted.promise.catch(() => {
      const current = queuedRef.current;
      if (current?.projectId === latest.projectId && current.revision === revision) {
        queuedRef.current = null;
        if (latestRef.current?.projectId === latest.projectId) {
          latestRef.current = { ...latestRef.current, stored: baseline };
        }
      }
    });
  }, []);

  return { draft, onChange, flush };
}

function ProjectDetail({ replica }: { replica: TaskdoReplica }) {
  const { projects: api, tasks: tasksApi, waits: waitsApi } = replica;
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
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

  const list = useMemo(() => projects ?? [], [projects]);
  const tasks = useMemo(() => openTasks ?? [], [openTasks]);
  const conds = useMemo(() => conditions ?? [], [conditions]);
  // Keep the outgoing workspace mounted during the native back transition.
  // Replacing its list with the missing-project view while Android is popping
  // the screen can reparent Fabric views that still belong to the list.
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const project = list.find((p) => p.id === id)
    ?? (deletingProject?.id === id ? deletingProject : null);

  const commitEdit = useCallback(
    (fields: ProjectEditFields) => {
      // Navigation and focus cleanup can flush a draft after optimistic deletion.
      // The collection is authoritative even while this render still has the project.
      if (!project || !api.collection.get(project.id)) return null;
      setError(null);
      const tx = api.edit(project.id, fields);
      tx.isPersisted.promise.catch((e) => setError(messageOf(e)));
      return tx;
    },
    [api, project],
  );
  const { draft, onChange: changeDraft, flush: flushDraft } = useProjectDraft(project, commitEdit);
  const back = useCallback(() => {
    flushDraft();
    router.back();
  }, [flushDraft, router]);
  useFocusEffect(useCallback(() => () => flushDraft(), [flushDraft]));

  const commitState = useCallback(
    (state: ProjectState) => {
      if (!project) return;
      setError(null);
      const failed = (e: unknown) => state === 'done'
        ? reportProjectFailure('Project not done · Retry')
        : setError(messageOf(e));
      try {
        const tx = api.setState(project.id, state);
        void tx.isPersisted.promise.catch(failed);
      } catch (e) { failed(e); }
    },
    [api, project],
  );

  const completeProject = useCallback(() => {
    if (!project) return;
    undoableAction({
      message: 'Project completed',
      description: `${project.icon} ${project.title}`,
      act: () => {
        const tx = api.setState(project.id, 'done');
        return tx;
      },
      undo: () => {
        const tx = api.reopen(project);
        return tx;
      },
      onError: () => reportProjectFailure('Project update failed · Retry'),
    });
  }, [api, project]);

  const commitDelete = useCallback(() => {
    if (!project) return;
    setError(null);
    // The write lives on the shared replica, not this screen, so it
    // persists even though we pop away immediately — no toast, no deferred window.
    // The canonical model cascades the project's tasks and waiting conditions
    // in the same local write.
    const failed = () => reportProjectFailure('Delete failed · Retry');
    try {
      setDeletingProject(project);
      const tx = api.remove(project.id);
      void tx.isPersisted.promise.catch(failed);
    } catch { setDeletingProject(null); failed(); }
  }, [api, project]);

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

  const add = useProjectAdd({
    project,
    projects: list,
    conditions: conds,
    openTasks: tasks,
    tasksApi,
    projectsApi: api,
    waitsApi,
    getToken,
    onError: setError,
  });

  // The task detail editor delegates Waiting feedback to the same Project add
  // drawer used by the FAB and section actions.
  const detail = useTaskDetail({
    replica,
    projects: list,
    openTasks: tasks,
    conditions: conds,
    currentProjectId: id,
    onAddWaiting: (destination) => add.openFor(destination, 'waiting'),
    onError: setError,
  });

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      flushDraft();
      if (detail.handleBack()) return true;
      if (add.handleBack()) return true;
      return false;
    });
    return () => sub.remove();
  }, [detail, add, flushDraft]);

  const { refreshing, onRefresh } = usePullRefresh(replica.refresh);
  const today = useLocalDay();
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
    <View
      testID="project-workspace"
      className="flex-1 bg-background"
      onTouchStart={flushDraft}
    >
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
        swipeAction="schedule-today"
        keyboardShouldPersistTaps="handled"
        header={
          <>
            {error ? (
              <Text variant="error" className="px-screen-x pb-2">
                {error}
              </Text>
            ) : null}

            <View className="gap-6 pb-2">
              <ProjectHeader
                project={project}
                statusLabel={statusLabel}
                deletionWarning={projectAfterRemovalWarning(
                  projectAfterRemovalImpact(project.id, conds, list),
                )}
                onEdit={commitEdit}
                title={draft.title}
                onChangeTitle={(value) => changeDraft('title', value)}
                onCommitTitle={flushDraft}
                description={
                  <ProjectDescription
                    value={draft.description}
                    onChange={(value) => changeDraft('description', value)}
                    onBlur={flushDraft}
                  />
                }
                onState={(state) => {
                  if (state === 'done') {
                    completeProject();
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

              <ProjectWaits
                project={project}
                waitsApi={waitsApi}
                projects={list}
                onAddWaiting={add.openWaiting}
                onAddAfter={add.openAfter}
                onError={setError}
              />

              {projectTasks.length > 0 ? (
                <ProjectSectionHeader
                  title="Tasks"
                  addLabel="Add task"
                  onAdd={add.openTask}
                />
              ) : null}
            </View>
          </>
        }
      />

      {detail.sheets}

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
  const authenticatedFeatures = useTodoDataContext()?.signedIn ?? false;
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
    if (open && authenticatedFeatures) {
      void requestIconSuggestions(getToken, project.id, basis);
    }
  }, [open, authenticatedFeatures, getToken, project.id, basis]);
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
        {authenticatedFeatures ? <>
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
        </> : null}
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
// status pill directly below it, then the supporting description. Settings stay
// secondary in the identity row.
function ProjectHeader({
  project,
  statusLabel,
  deletionWarning,
  onEdit,
  title,
  onChangeTitle,
  onCommitTitle,
  description,
  onState,
  onDelete,
}: {
  project: Project;
  statusLabel: string;
  deletionWarning: string | null;
  onEdit: (fields: ProjectEditFields) => void;
  title: string;
  onChangeTitle: (value: string) => void;
  onCommitTitle: () => void;
  description: ReactNode;
  onState: (state: ProjectState) => void;
  onDelete: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const foreground = useColor('--color-foreground');
  const secondary = useColor('--color-foreground-secondary');
  const danger = useColor('--color-danger');
  const ripple = useColor('--color-ripple');

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
  return (
    <View className="gap-2 px-screen-x">
      <View className="min-h-12 flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change icon"
          hitSlop={8}
          className="min-h-12 min-w-12 items-center justify-center"
          onPress={() => setPickerOpen(true)}
        >
          <Text className="text-[24px]">{project.icon}</Text>
        </Pressable>
        <Input
          value={title}
          onChangeText={onChangeTitle}
          onBlur={onCommitTitle}
          onSubmitEditing={onCommitTitle}
          returnKeyType="done"
          blurOnSubmit
          accessibilityLabel="Project title"
          className="flex-1 text-editor"
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
                `This permanently deletes the project, all its tasks (including completed tasks), its waiting conditions, and its After relationships. This cannot be undone.${deletionWarning ? ` ${deletionWarning}` : ''}`,
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
            className="min-h-12 min-w-12 items-center justify-center"
          >
            <Text className="text-[22px] text-foreground-muted">⋯</Text>
          </View>
        </MenuView>
      </View>
      <View className="flex-row">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Project status: ${statusLabel}`}
          accessibilityHint="Change project status"
          hitSlop={9}
          android_ripple={{ color: ripple }}
          onPress={() => setStatusOpen(true)}
          className="max-w-full flex-row items-center gap-2 overflow-hidden rounded-full bg-surface-muted px-3 py-1.5"
        >
          <Text
            variant="caption"
            numberOfLines={1}
            className="font-medium"
          >
            {statusLabel}
          </Text>
          <View pointerEvents="none" importantForAccessibility="no">
            <Host matchContents>
              <Icon name={STATUS_DISCLOSURE_ICON} size={16} color={secondary} />
            </Host>
          </View>
        </Pressable>
      </View>
      {description}
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

function ProjectSectionHeader({
  title,
  addLabel,
  onAdd,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
}) {
  const accent = useColor('--color-accent');
  return (
    <View className="min-h-12 flex-row items-center justify-between px-screen-x">
      <Text variant="section">{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={addLabel}
        className="min-h-12 min-w-12 items-center justify-center"
        onPress={onAdd}
      >
        <View pointerEvents="none" importantForAccessibility="no">
          <Host matchContents>
            <Icon name={ADD_ICON} size={22} color={accent} />
          </Host>
        </View>
      </Pressable>
    </View>
  );
}

function RemoveAction({
  accessibilityLabel,
  onPress,
  roomy = false,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  roomy?: boolean;
}) {
  const muted = useColor('--color-foreground-muted');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className={
        roomy
          ? 'min-h-14 min-w-16 items-center justify-center px-2'
          : 'min-h-12 min-w-12 items-center justify-center'
      }
      onPress={onPress}
    >
      <View pointerEvents="none" importantForAccessibility="no">
        <Host matchContents>
          <Icon name={REMOVE_ICON} size={20} color={muted} />
        </Host>
      </View>
    </Pressable>
  );
}

function conditionLabel(condition: WaitingCondition): string {
  return condition.kind === 'free-text' ? condition.text : '';
}

// After rows render as navigable Project identities. Manual conditions remain
// under Waiting on. Future Task dates stay in status and Task presentation.
function ProjectWaits({
  project,
  waitsApi,
  projects,
  onAddWaiting,
  onAddAfter,
  onError,
}: {
  project: Project;
  waitsApi: TodoWaits;
  projects: Project[];
  onAddWaiting: () => void;
  onAddAfter: () => void;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const muted = useColor('--color-foreground-muted');
  const { data: allConditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );
  const afters = projectAfters(project.id, allConditions ?? [], projects);
  const list = (allConditions ?? []).filter(
    (condition: WaitingCondition) =>
      condition.projectId === project.id &&
      condition.resolvedAt == null &&
      !isProjectAfter(condition),
  );
  const write = (tx: { isPersisted: { promise: Promise<unknown> } }) => {
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  };

  if (list.length === 0 && afters.length === 0) return null;

  return (
    <View className="gap-6">
      {list.length > 0 ? (
        <View>
          <ProjectSectionHeader
            title="Waiting on"
            addLabel="Add waiting condition"
            onAdd={onAddWaiting}
          />
          <View className="px-screen-x">
            {list.map((condition) => {
              const label = conditionLabel(condition);
              return (
                <View key={condition.id} className="flex-row items-center gap-2 py-1">
                  <Text className="flex-1">{label}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Resolve condition: ${label}`}
                    className="min-h-12 min-w-12 items-center justify-center"
                    onPress={() => write(waitsApi.resolveWaiting(condition.id))}
                  >
                    <Text variant="caption" className="font-semibold text-accent">
                      Resolve
                    </Text>
                  </Pressable>
                  <RemoveAction
                    accessibilityLabel={`Delete condition: ${label}`}
                    onPress={() => write(waitsApi.remove(condition.id))}
                  />
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      {afters.length > 0 ? (
        <View>
          <ProjectSectionHeader
            title="After"
            addLabel="Add After project"
            onAdd={onAddAfter}
          />
          {afters.map(({ relationship, target }) => (
            <View key={relationship.id} className="flex-row items-stretch border-b border-divider">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open project ${target?.title ?? 'After project'}`}
                disabled={!target}
                className="min-h-14 flex-1 flex-row items-center gap-3 px-screen-x py-2"
                onPress={() => {
                  if (target) router.push(`/projects/${target.id}`);
                }}
              >
                <Text className="w-6 text-center text-[18px]">{target?.icon ?? '📁'}</Text>
                <Text className="min-w-0 flex-1 font-medium">
                  {target?.title ?? 'Another project'}
                </Text>
                <View pointerEvents="none" importantForAccessibility="no">
                  <Host matchContents>
                    <Icon name={ROW_DISCLOSURE_ICON} size={20} color={muted} />
                  </Host>
                </View>
              </Pressable>
              <RemoveAction
                accessibilityLabel={`Remove After relationship with ${target?.title ?? 'project'}`}
                roomy
                onPress={() => write(waitsApi.remove(relationship.id))}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// The project's description input is deliberately shallow: the workspace owns
// its draft and decides when actions and lifecycle events flush it.
function ProjectDescription({
  value,
  onChange,
  onBlur,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <Input
      value={value}
      onChangeText={onChange}
      onBlur={onBlur}
      multiline
      placeholder="What outcome are you after, and why does it matter?"
      accessibilityLabel="Project description"
      placeholderTextColorClassName="text-foreground-secondary"
      className="text-subtitle"
    />
  );
}
