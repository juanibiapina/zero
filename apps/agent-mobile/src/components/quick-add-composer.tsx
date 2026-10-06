import {
  ADD_MODE_PLACEHOLDER,
  defaultToastController,
  messageOf,
  TaskDraft,
  toast,
  type AddMode,
  type Project,
  type ProjectSelection,
  type TodoProjects,
  type TodoTasks,
  type Task,
  type WaitingCondition,
  type TodoWaits,
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
import type { TokenGetter } from '@/lib/api';
import { useNewProjectIcon } from '@/lib/new-project-icon';
import { useProjectSuggestion } from '@/lib/project-suggestion';
import { useLocalDay } from '@/lib/local-day';
import { showTaskDestination } from '@/lib/task-feedback';
import { useTodoDataContext } from '@/lib/todo-data-context';

export type QuickAddScope =
  | { kind: 'global' }
  | {
      kind: 'project';
      project: Project | null;
      waitsApi: TodoWaits;
    };

const NO_PROJECT: ProjectSelection = { projectId: null, source: 'none' };

const fixedProject = (projectId: string | null): ProjectSelection =>
  projectId ? { projectId, source: 'context' } : NO_PROJECT;

export type QuickAddController = {
  bar: ReactNode;
  handleBack: () => boolean;
  active: boolean;
  open: (options?: { initialMode?: AddMode; projectId?: string }) => void;
};

// One controller owns the create drawer, per-mode drafts, Task metadata, Project
// pickers, writes, discard confirmation, and Android Back order. Global callers
// use Task/Project. useProjectAdd supplies the grouped Project context required
// by Waiting and After, so those modes cannot be configured from loose optional
// props.
export function useQuickAdd({
  tasksApi,
  projectsApi,
  projects,
  openTasks,
  conditions,
  modes,
  scope,
  getToken,
  onError,
  fabLabel,
  onProjectCreated,
  onClosed,
  showFab = true,
  waitForPersist = false,
}: {
  tasksApi: TodoTasks;
  projectsApi: TodoProjects;
  projects: Project[];
  openTasks: Task[];
  conditions: WaitingCondition[];
  modes: AddMode[];
  scope: QuickAddScope;
  getToken: TokenGetter;
  onError: (message: string | null) => void;
  fabLabel: string;
  onProjectCreated?: (id: string) => void;
  onClosed?: () => void;
  showFab?: boolean;
  waitForPersist?: boolean;
}): QuickAddController {
  const authenticatedFeatures = useTodoDataContext()?.signedIn ?? false;
  const [taskDraft, setTaskDraft] = useState(() => TaskDraft.create());
  const [drafts, setDrafts] = useState<Record<Exclude<AddMode, 'task'>, string>>({
    waiting: '',
    after: '',
    project: '',
  });
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<AddMode>(modes[0] ?? 'task');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [schedulingAdd, setSchedulingAdd] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const [pickingAfter, setPickingAfter] = useState(false);
  const [pickingIcon, setPickingIcon] = useState(false);
  const inputRef = useRef<{ focus: () => void }>(null);
  const ignoreNextKeyboardHide = useRef(false);

  const contextProject = scope.kind === 'project' ? scope.project : null;
  const contextProjectId = contextProject?.id ?? null;
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
    enabled: authenticatedFeatures && adding && mode === 'task' && scope.kind === 'global',
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

  const closeAdd = useCallback(() => {
    ignoreNextKeyboardHide.current = true;
    Keyboard.dismiss();
    setDrafts({ waiting: '', after: '', project: '' });
    setTaskDraft(TaskDraft.create());
    setConfirmingDiscard(false);
    setAdding(false);
    resetProject(NO_PROJECT);
    resetProjectIcon();
    setSchedulingAdd(false);
    setPickingProject(false);
    setPickingAfter(false);
    setPickingIcon(false);
    setMode(modes[0] ?? 'task');
    onClosed?.();
  }, [modes, onClosed, resetProject, resetProjectIcon]);

  const open = useCallback(
    (options?: { initialMode?: AddMode; projectId?: string }) => {
      defaultToastController.dismiss();
      ignoreNextKeyboardHide.current = false;
      const initialMode =
        options?.initialMode && modes.includes(options.initialMode)
          ? options.initialMode
          : (modes[0] ?? 'task');
      setMode(initialMode);
      resetProject(fixedProject(options?.projectId ?? contextProjectId));
      setAdding(true);
      setPickingAfter(initialMode === 'after');
    },
    [modes, contextProjectId, resetProject],
  );

  const selectMode = useCallback(
    (nextMode: AddMode) => {
      setMode(nextMode);
      if (nextMode === 'task' && contextProjectId) {
        resetProject(fixedProject(contextProjectId));
      }
      if (nextMode === 'after') setPickingAfter(true);
    },
    [contextProjectId, resetProject],
  );

  const onAdd = useCallback(() => {
    if (mode === 'after') {
      setPickingAfter(true);
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      closeAdd();
      return;
    }
    onError(null);

    if (mode === 'waiting') {
      if (scope.kind !== 'project' || !contextProject) return;
      const tx = scope.waitsApi.addWaiting(contextProject.id, trimmed);
      tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
      closeAdd();
      return;
    }

    if (mode === 'project') {
      const icon = projectIcon.choice.icon;
      const tx = projectsApi.add(trimmed, icon);
      tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
      const id = String(tx.mutations[0]?.key);
      if (onProjectCreated) {
        closeAdd();
        onProjectCreated(id);
        return;
      }
      toast('Project created', {
        description: `${icon} ${trimmed}`,
        action: {
          label: 'View',
          onPress: () =>
            router.navigate(`/projects/${id}`, { withAnchor: true }),
        },
      });
      closeAdd();
      return;
    }

    const prepared = taskView.commit;
    if (prepared.kind !== 'ready') return;
    const taskText = prepared.text;
    defaultToastController.dismiss();
    const tx = tasksApi.add(
      taskText,
      effectiveDate,
      addProjectId,
      effectiveRecurrence,
    );
    if (waitForPersist) {
      void tx.isPersisted.promise.then(() => {
        if (addProjectId != null && addProjectId !== contextProjectId) {
          showTaskDestination(
            { showUpDate: effectiveDate, projectId: addProjectId },
            projects,
            'created',
          );
        }
        closeAdd();
      }, (error) => onError(messageOf(error)));
      return;
    }
    tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
    if (addProjectId != null && addProjectId !== contextProjectId) {
      showTaskDestination(
        { showUpDate: effectiveDate, projectId: addProjectId },
        projects,
        'created',
      );
    }
    closeAdd();
  }, [
    mode,
    text,
    closeAdd,
    onError,
    scope,
    contextProject,
    projectsApi,
    projectIcon.choice.icon,
    onProjectCreated,
    taskView,
    tasksApi,
    effectiveDate,
    addProjectId,
    effectiveRecurrence,
    contextProjectId,
    projects,
    waitForPersist,
  ]);

  const closeIconPicker = useCallback(() => {
    setPickingIcon(false);
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
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
    } else if (hasDraft) {
      setConfirmingDiscard(true);
    } else {
      closeAdd();
    }
  }, [confirmingDiscard, hasDraft, closeAdd]);

  const handleKeyboardWillHide = useCallback(() => {
    if (ignoreNextKeyboardHide.current) {
      ignoreNextKeyboardHide.current = false;
      return;
    }
    if (
      !adding ||
      confirmingDiscard ||
      pickingAfter ||
      pickingProject ||
      pickingIcon ||
      schedulingAdd
    ) {
      return;
    }
    requestClose();
  }, [
    adding,
    confirmingDiscard,
    pickingAfter,
    pickingProject,
    pickingIcon,
    schedulingAdd,
    requestClose,
  ]);

  const handleBack = useCallback(() => {
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
      return true;
    }
    if (pickingAfter) {
      setPickingAfter(false);
      return true;
    }
    if (pickingProject) {
      setPickingProject(false);
      return true;
    }
    if (pickingIcon) {
      closeIconPicker();
      return true;
    }
    if (schedulingAdd) {
      setSchedulingAdd(false);
      return true;
    }
    if (adding && hasDraft) {
      setConfirmingDiscard(true);
      return true;
    }
    if (adding) {
      closeAdd();
      return true;
    }
    return false;
  }, [
    confirmingDiscard,
    pickingAfter,
    pickingProject,
    pickingIcon,
    closeIconPicker,
    schedulingAdd,
    adding,
    hasDraft,
    closeAdd,
  ]);

  const taskActionsVisible = mode === 'task';
  const selectedProject = projects.find((project) => project.id === addProjectId) ?? null;
  const submitLabel =
    mode === 'waiting'
      ? contextProject
        ? `Add waiting condition to ${contextProject.title}`
        : 'Add waiting condition'
      : mode === 'project'
        ? 'Add project'
        : fabLabel;

  const bar = (
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
        collapsedFabLabel={fabLabel}
        inputRef={inputRef}
        inputAccessibilityLabel={mode === 'waiting' ? 'Waiting on' : undefined}
        leading={
          mode === 'project' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Change icon, ${projectIcon.choice.icon}`}
              hitSlop={8}
              onPress={() => setPickingIcon(true)}
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
              onPress={() => setPickingAfter(true)}
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
                onPress: () => setSchedulingAdd(true),
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
                onPress: () => setPickingProject(true),
              }
            : undefined
        }
        overlay={
          confirmingDiscard ? (
            <ConfirmDialog
              title="Discard changes?"
              message="The changes you've made will not be saved."
              cancelLabel="Cancel"
              confirmLabel="Discard"
              destructive
              onCancel={() => {
                setConfirmingDiscard(false);
                inputRef.current?.focus();
              }}
              onConfirm={closeAdd}
            />
          ) : null
        }
      />

      <EmojiPickerSheet
        open={pickingIcon}
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
        open={schedulingAdd}
        showUpDate={taskView.pickerDate}
        onPick={(date) => {
          setTaskDraft((current) => current.pickCreationDate(date, today));
          setSchedulingAdd(false);
        }}
        onClose={() => setSchedulingAdd(false)}
      />

      <ProjectPickerSheet
        title="Project"
        open={pickingProject}
        projects={projects}
        openTasks={openTasks}
        conditions={conditions}
        selectedProjectId={addProjectId}
        onPick={(id) => {
          projectChoice.pick(id);
          setPickingProject(false);
        }}
        onClose={() => setPickingProject(false)}
      />

      <ProjectPickerSheet
        open={pickingAfter}
        title="After project"
        projects={projects}
        openTasks={openTasks}
        conditions={conditions}
        afterSourceProjectId={contextProject?.id ?? null}
        selectedProjectId={null}
        showNoProject={false}
        emptyCopy="No available projects"
        onPick={(afterProjectId) => {
          if (
            afterProjectId &&
            scope.kind === 'project' &&
            contextProject
          ) {
            const tx = scope.waitsApi.addAfter(
              contextProject.id,
              afterProjectId,
            );
            tx.isPersisted.promise.catch((error) =>
              onError(messageOf(error)),
            );
            closeAdd();
            return;
          }
          setPickingAfter(false);
        }}
        onClose={() => setPickingAfter(false)}
      />
    </>
  );

  return {
    bar,
    open,
    handleBack,
    active:
      adding ||
      schedulingAdd ||
      pickingProject ||
      pickingAfter ||
      pickingIcon ||
      confirmingDiscard,
  };
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
