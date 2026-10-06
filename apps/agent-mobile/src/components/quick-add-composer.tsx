import { useAuth } from '@clerk/expo';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  ADD_MODE_PLACEHOLDER,
  defaultToastController,
  messageOf,
  TaskDraft,
  toast,
  type AddMode,
  type Project,
  type ProjectSelection,
  type TaskdoReplica,
} from '@zero/agent-core';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, View } from 'react-native';

import { EmojiPickerSheet } from '@/components/emoji-picker-sheet';
import { ProjectPickerSheet, ScheduleSheet } from '@/components/task-detail';
import { AddModeSelector, TaskEditorSheet } from '@/components/task-editor-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Fab } from '@/components/ui/fab';
import { Text } from '@/components/ui/text';
import { useNewProjectIcon } from '@/lib/new-project-icon';
import { useProjectSuggestion } from '@/lib/project-suggestion';
import { useLocalDay } from '@/lib/local-day';
import { showTaskDestination } from '@/lib/task-feedback';
import { useTodoDataContext } from '@/lib/todo-data-context';

// The screen that mounts the + drawer. The surface decides whether the + shows
// and which modes it offers; opening with a Project offers the Project modes.
export type QuickAddSurface =
  | { kind: 'home' }
  | { kind: 'upcoming' }
  | { kind: 'projects' }
  | { kind: 'project'; project: Project | null };

export type QuickAddController = {
  element: ReactNode;
  open: (mode?: AddMode, project?: Project) => void;
  handleBack: () => boolean;
};

type Overlay = 'discard' | 'schedule' | 'project' | 'after' | 'icon';

type Persisting = { isPersisted: { promise: Promise<unknown> } };

const PROJECT_MODES: AddMode[] = ['task', 'waiting', 'after', 'project'];

function modesFor(surface: QuickAddSurface['kind'], destination: Project | null): AddMode[] {
  if (destination) return PROJECT_MODES;
  return surface === 'projects' ? ['project', 'task'] : ['task', 'project'];
}

const NO_PROJECT: ProjectSelection = { projectId: null, source: 'none' };

const fixedProject = (projectId: string | null): ProjectSelection =>
  projectId ? { projectId, source: 'context' } : NO_PROJECT;

// The + button and add drawer for every todo screen: per-mode drafts, Task
// metadata, pickers, writes, discard confirmation, and Android Back order. A
// screen mounts one and renders `element` once. `onProjectCreated` replaces the
// default "Project created" toast, for a screen that navigates instead.
export function useQuickAdd({
  replica,
  surface,
  onError,
  onProjectCreated,
}: {
  replica: TaskdoReplica;
  surface: QuickAddSurface;
  onError: (message: string | null) => void;
  onProjectCreated?: (id: string) => void;
}): QuickAddController {
  const authenticatedFeatures = useTodoDataContext()?.signedIn ?? false;
  const { getToken } = useAuth();
  const { data: projectRows } = useLiveQuery(
    (q) => q.from({ p: replica.projects.collection }).orderBy(({ p }) => p.createdAt, 'asc'),
    [replica],
  );
  const { data: openTaskRows } = useLiveQuery(
    (q) => q.from({ t: replica.tasks.collection }).where(({ t }) => isNull(t.completedAt)),
    [replica],
  );
  const { data: conditionRows } = useLiveQuery(
    (q) => q.from({ w: replica.waits.collection }),
    [replica],
  );
  const projects = useMemo(() => projectRows ?? [], [projectRows]);
  const openTasks = useMemo(() => openTaskRows ?? [], [openTaskRows]);
  const conditions = useMemo(() => conditionRows ?? [], [conditionRows]);

  const surfaceProject = surface.kind === 'project' ? surface.project : null;
  const [destination, setDestination] = useState<Project | null>(null);
  const contextProject = destination
    ? (projects.find((project) => project.id === destination.id) ?? destination)
    : surfaceProject;
  const contextProjectId = contextProject?.id ?? null;
  const modes = modesFor(surface.kind, contextProject);
  const showFab = surface.kind !== 'upcoming' && (surface.kind !== 'project' || surfaceProject != null);

  const [taskDraft, setTaskDraft] = useState(() => TaskDraft.create());
  const [drafts, setDrafts] = useState<Record<Exclude<AddMode, 'task'>, string>>({
    waiting: '',
    after: '',
    project: '',
  });
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<AddMode>(modes[0] ?? 'task');
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const inputRef = useRef<{ focus: () => void }>(null);
  const ignoreNextKeyboardHide = useRef(false);
  const saving = useRef(false);

  const text = mode === 'task' ? taskDraft.text : drafts[mode];
  const hasDraft = [taskDraft.text, ...Object.values(drafts)].some((draft) => draft.trim() !== '');
  const today = useLocalDay();
  const taskView = useMemo(() => taskDraft.view(today), [taskDraft, today]);
  const effectiveDate = taskView.date;
  const effectiveRecurrence = taskView.recurrence;
  const projectChoice = useProjectSuggestion({
    getToken,
    initial: NO_PROJECT,
    title: adding && mode === 'task' ? taskView.title : '',
    projects,
    tasks: openTasks,
    enabled: authenticatedFeatures && adding && mode === 'task' && contextProject == null,
  });
  const addProjectId = projectChoice.selection.projectId;
  const resetProject = projectChoice.reset;
  const projectIcon = useNewProjectIcon({
    getToken,
    title: adding && mode === 'project' ? drafts.project : '',
    enabled: authenticatedFeatures && adding && mode === 'project',
  });
  const resetProjectIcon = projectIcon.reset;
  const setText = useCallback(
    (next: string) => {
      if (mode === 'task') setTaskDraft((current) => current.change(next));
      else setDrafts((current) => ({ ...current, [mode]: next }));
    },
    [mode],
  );

  // Closing keeps the current mode: swapping the focused field while the
  // keyboard hides would hand focus to another field and keep the keyboard up.
  // `open` sets the mode every time.
  const closeAdd = useCallback(() => {
    ignoreNextKeyboardHide.current = true;
    Keyboard.dismiss();
    setDrafts({ waiting: '', after: '', project: '' });
    setTaskDraft(TaskDraft.create());
    setAdding(false);
    setOverlay(null);
    setDestination(null);
    resetProject(NO_PROJECT);
    resetProjectIcon();
  }, [resetProject, resetProjectIcon]);

  // Every add waits for the local write, then closes. A rejected write keeps
  // the drawer and its draft open and reports the error.
  const persistThen = useCallback(
    (tx: Persisting, done: () => void) => {
      saving.current = true;
      tx.isPersisted.promise.then(
        () => {
          saving.current = false;
          done();
        },
        (error) => {
          saving.current = false;
          onError(messageOf(error));
        },
      );
    },
    [onError],
  );

  const open = useCallback(
    (requested?: AddMode, project?: Project) => {
      defaultToastController.dismiss();
      ignoreNextKeyboardHide.current = false;
      const target = project ?? surfaceProject;
      const available = modesFor(surface.kind, target);
      const initialMode =
        requested && available.includes(requested) ? requested : (available[0] ?? 'task');
      setDestination(project ?? null);
      setMode(initialMode);
      resetProject(fixedProject(target?.id ?? null));
      setAdding(true);
      setOverlay(initialMode === 'after' ? 'after' : null);
    },
    [surface.kind, surfaceProject, resetProject],
  );

  const selectMode = useCallback(
    (nextMode: AddMode) => {
      setMode(nextMode);
      if (nextMode === 'task' && contextProjectId) {
        resetProject(fixedProject(contextProjectId));
      }
      if (nextMode === 'after') setOverlay('after');
    },
    [contextProjectId, resetProject],
  );

  const onAdd = useCallback(() => {
    if (saving.current) return;
    if (mode === 'after') {
      setOverlay('after');
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      closeAdd();
      return;
    }
    onError(null);

    if (mode === 'waiting') {
      if (!contextProject) return;
      persistThen(replica.waits.addWaiting(contextProject.id, trimmed), closeAdd);
      return;
    }

    if (mode === 'project') {
      const icon = projectIcon.choice.icon;
      const tx = replica.projects.add(trimmed, icon);
      const id = String(tx.mutations[0]?.key);
      persistThen(tx, () => {
        closeAdd();
        if (onProjectCreated) {
          onProjectCreated(id);
          return;
        }
        toast('Project created', {
          description: `${icon} ${trimmed}`,
          action: {
            label: 'View',
            onPress: () => router.navigate(`/projects/${id}`, { withAnchor: true }),
          },
        });
      });
      return;
    }

    const prepared = taskView.commit;
    if (prepared.kind !== 'ready') return;
    defaultToastController.dismiss();
    const tx = replica.tasks.add(prepared.text, effectiveDate, addProjectId, effectiveRecurrence);
    persistThen(tx, () => {
      if (addProjectId != null && addProjectId !== contextProjectId) {
        showTaskDestination(
          { showUpDate: effectiveDate, projectId: addProjectId },
          projects,
          'created',
        );
      }
      closeAdd();
    });
  }, [
    mode,
    text,
    closeAdd,
    onError,
    contextProject,
    persistThen,
    replica,
    projectIcon.choice.icon,
    onProjectCreated,
    taskView,
    effectiveDate,
    addProjectId,
    effectiveRecurrence,
    contextProjectId,
    projects,
  ]);

  const closeIconPicker = useCallback(() => {
    setOverlay(null);
    inputRef.current?.focus();
  }, []);
  const pickIcon = useCallback(
    (emoji: string) => {
      projectIcon.pick(emoji);
      closeIconPicker();
    },
    [projectIcon, closeIconPicker],
  );

  const requestClose = useCallback(() => {
    if (overlay === 'discard') {
      setOverlay(null);
    } else if (hasDraft) {
      setOverlay('discard');
    } else {
      closeAdd();
    }
  }, [overlay, hasDraft, closeAdd]);

  const handleKeyboardWillHide = useCallback(() => {
    if (ignoreNextKeyboardHide.current) {
      ignoreNextKeyboardHide.current = false;
      return;
    }
    if (!adding || overlay != null || saving.current) return;
    requestClose();
  }, [adding, overlay, requestClose]);

  const handleBack = useCallback(() => {
    if (overlay === 'icon') {
      closeIconPicker();
      return true;
    }
    if (overlay != null) {
      setOverlay(null);
      return true;
    }
    if (adding && hasDraft) {
      setOverlay('discard');
      return true;
    }
    if (adding) {
      closeAdd();
      return true;
    }
    return false;
  }, [overlay, closeIconPicker, adding, hasDraft, closeAdd]);

  const taskActionsVisible = mode === 'task';
  const selectedProject = projects.find((project) => project.id === addProjectId) ?? null;
  const submitLabel =
    mode === 'waiting'
      ? contextProject
        ? `Add waiting condition to ${contextProject.title}`
        : 'Add waiting condition'
      : mode === 'project'
        ? 'Add project'
        : 'Add';

  const element = (
    <>
      <TaskEditorSheet
        open={adding}
        onClose={requestClose}
        dismissLabel="Dismiss quick add"
        draft={text}
        onChangeDraft={setText}
        highlightRanges={mode === 'task' ? taskView.ranges : undefined}
        onDismissHighlight={(range) => setTaskDraft((current) => current.dismiss(range))}
        onSubmit={onAdd}
        placeholder={ADD_MODE_PLACEHOLDER[mode]}
        autoFocus={mode !== 'after'}
        inline
        onKeyboardWillHide={handleKeyboardWillHide}
        onOpen={showFab ? () => open() : undefined}
        collapsedFabLabel="Add"
        inputRef={inputRef}
        inputAccessibilityLabel={mode === 'waiting' ? 'Waiting on' : undefined}
        leading={
          mode === 'project' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Change icon, ${projectIcon.choice.icon}`}
              hitSlop={8}
              onPress={() => setOverlay('icon')}
              className="h-9 w-9 items-center justify-center rounded-md"
            >
              <Text className="text-[22px]">{projectIcon.choice.icon}</Text>
            </Pressable>
          ) : undefined
        }
        secondaryContent={
          mode === 'project' && authenticatedFeatures ? (
            <IconStrip
              icons={projectIcon.choice.icons}
              chosen={projectIcon.choice.icon}
              onPick={projectIcon.pick}
            />
          ) : undefined
        }
        modeSelector={
          modes.length > 1 ? (
            <AddModeSelector
              mode={mode}
              modes={modes}
              onModeChange={selectMode}
            />
          ) : undefined
        }
        context={
          mode === 'waiting' && contextProject ? (
            <View className="px-screen-x pt-3">
              <Text variant="caption" className="font-semibold">
                Project
              </Text>
              <View
                accessible
                accessibilityLabel={`Project ${contextProject.title}`}
                className="min-h-12 flex-row items-center gap-3"
              >
                <Text className="w-6 text-center text-[20px]">
                  {contextProject.icon}
                </Text>
                <Text className="min-w-0 flex-1 font-medium">
                  {contextProject.title}
                </Text>
              </View>
              <Text variant="caption" className="pt-3 font-semibold">
                Waiting on
              </Text>
            </View>
          ) : undefined
        }
        editorContent={
          mode === 'after' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose an After project"
              onPress={() => setOverlay('after')}
              className="min-h-16 flex-row items-center gap-3 px-screen-x py-4"
            >
              <Text className="flex-1 text-foreground-secondary">
                Choose a project
              </Text>
              <Text className="font-medium text-accent">Choose</Text>
            </Pressable>
          ) : undefined
        }
        trailing={
          mode !== 'after' ? (
            <Fab
              label={submitLabel}
              testID="quick-add-submit"
              size="sm"
              disabled={text.trim().length === 0}
              onPress={onAdd}
            />
          ) : undefined
        }
        scheduleAction={
          taskActionsVisible
            ? {
                label: taskView.label,
                active: effectiveDate != null,
                onPress: () => setOverlay('schedule'),
              }
            : undefined
        }
        projectAction={
          taskActionsVisible
            ? {
                label: selectedProject ? selectedProject.title : 'No project',
                icon: selectedProject?.icon ?? null,
                active: addProjectId != null,
                note:
                  selectedProject && projectChoice.selection.source === 'suggested'
                    ? 'Suggested'
                    : undefined,
                onPress: () => setOverlay('project'),
              }
            : undefined
        }
        overlay={
          overlay === 'discard' ? (
            <ConfirmDialog
              title="Discard changes?"
              message="The changes you've made will not be saved."
              cancelLabel="Cancel"
              confirmLabel="Discard"
              destructive
              onCancel={() => {
                setOverlay(null);
                inputRef.current?.focus();
              }}
              onConfirm={closeAdd}
            />
          ) : null
        }
      />

      <EmojiPickerSheet
        open={overlay === 'icon'}
        onClose={closeIconPicker}
        onPick={pickIcon}
        header={
          projectIcon.choice.icons.length > 0 ? (
            <IconStrip
              icons={projectIcon.choice.icons}
              chosen={projectIcon.choice.icon}
              onPick={pickIcon}
            />
          ) : null
        }
      />

      <ScheduleSheet
        open={overlay === 'schedule'}
        showUpDate={taskView.pickerDate}
        onPick={(date) => {
          setTaskDraft((current) => current.pickCreationDate(date, today));
          setOverlay(null);
        }}
        onClose={() => setOverlay(null)}
      />

      <ProjectPickerSheet
        title="Project"
        open={overlay === 'project'}
        projects={projects}
        openTasks={openTasks}
        conditions={conditions}
        selectedProjectId={addProjectId}
        onPick={(id) => {
          projectChoice.pick(id);
          setOverlay(null);
        }}
        onClose={() => setOverlay(null)}
      />

      <ProjectPickerSheet
        open={overlay === 'after'}
        title="After project"
        projects={projects}
        openTasks={openTasks}
        conditions={conditions}
        afterSourceProjectId={contextProjectId}
        selectedProjectId={null}
        showNoProject={false}
        emptyCopy="No available projects"
        onPick={(afterProjectId) => {
          if (afterProjectId && contextProject && !saving.current) {
            onError(null);
            persistThen(replica.waits.addAfter(contextProject.id, afterProjectId), closeAdd);
            return;
          }
          setOverlay(null);
        }}
        onClose={() => setOverlay(null)}
      />
    </>
  );

  return { element, open, handleBack };
}

function IconStrip({
  icons,
  chosen,
  onPick,
}: {
  icons: string[];
  chosen: string;
  onPick: (emoji: string) => void;
}) {
  return (
    <View
      accessibilityLabel="Suggested icons"
      className="h-12 flex-row items-center gap-2 overflow-hidden px-screen-x"
    >
      {icons.map((emoji) => {
        const selected = emoji === chosen;
        return (
          <Pressable
            key={emoji}
            accessibilityRole="button"
            accessibilityLabel={`Use icon ${emoji}`}
            accessibilityState={{ selected }}
            hitSlop={6}
            onPress={() => onPick(emoji)}
            className={
              selected
                ? 'h-10 w-10 items-center justify-center rounded-md bg-surface-muted'
                : 'h-10 w-10 items-center justify-center rounded-md'
            }
          >
            <Text className="text-[22px]">{emoji}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
