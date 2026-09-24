import {
  ADD_MODE_PLACEHOLDER,
  DEFAULT_ICON,
  defaultToastController,
  messageOf,
  scheduleLabel,
  toast,
  type AddMode,
  type Project,
  type ProjectsApi,
  type TasksApi,
  type Task,
  type WaitingCondition,
  type WaitsApi,
} from '@zero/agent-core';
import {
  parseSchedule,
  toText,
  type TextRange,
} from '@zeroapps/recurrence';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, View } from 'react-native';

import { ProjectPickerSheet, ScheduleSheet } from '@/components/task-detail';
import { AddModeSelector, TaskEditorSheet } from '@/components/task-editor-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Fab } from '@/components/ui/fab';
import { Text } from '@/components/ui/text';
import type { TokenGetter } from '@/lib/api';
import { requestIconSuggestions } from '@/lib/icon-suggestions';
import { useLocalDay } from '@/lib/local-day';
import { showTaskDestination } from '@/lib/task-feedback';

export type QuickAddScope =
  | { kind: 'global' }
  | {
      kind: 'project';
      project: Project | null;
      waitsApi: WaitsApi;
    };

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
}: {
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
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
}): QuickAddController {
  const [drafts, setDrafts] = useState<Record<AddMode, string>>({
    task: '',
    waiting: '',
    after: '',
    project: '',
  });
  const [ignoredSchedule, setIgnoredSchedule] = useState<{
    text: string;
    ranges: TextRange[];
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<AddMode>(modes[0] ?? 'task');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [addProjectId, setAddProjectId] = useState<string | null>(null);
  const [schedulingAdd, setSchedulingAdd] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const [pickingAfter, setPickingAfter] = useState(false);
  const inputRef = useRef<{ focus: () => void }>(null);

  const contextProject = scope.kind === 'project' ? scope.project : null;
  const contextProjectId = contextProject?.id ?? null;
  const text = drafts[mode];
  const hasDraft = Object.values(drafts).some((draft) => draft.trim() !== '');
  const today = useLocalDay();
  const parsedSchedule = useMemo(
    () =>
      mode === 'task'
        ? parseSchedule(text, {
            today,
            weekStartsOn: 'MO',
            ignored: ignoredSchedule?.text === text ? ignoredSchedule.ranges : [],
          })
        : { kind: 'none' as const },
    [mode, text, today, ignoredSchedule],
  );
  const parsedValue =
    parsedSchedule.kind === 'scheduled' ? parsedSchedule.schedule : null;
  const effectiveText =
    parsedSchedule.kind === 'scheduled'
      ? parsedSchedule.remainingText
      : text.trim();
  const effectiveRecurrence =
    parsedValue?.kind === 'recurring' ? parsedValue.recurrence : null;
  const effectiveDate =
    parsedValue?.kind === 'once'
      ? parsedValue.date
      : effectiveRecurrence?.origin ?? addDate;
  const setText = useCallback(
    (next: string) => {
      setDrafts((current) => ({ ...current, [mode]: next }));
      if (mode === 'task' && next !== ignoredSchedule?.text) {
        setIgnoredSchedule(null);
      }
    },
    [mode, ignoredSchedule],
  );

  const ignoreScheduleRange = (range: TextRange) => {
    setIgnoredSchedule((current) => ({
      text,
      ranges:
        current?.text === text ? [...current.ranges, range] : [range],
    }));
  };

  const closeAdd = useCallback(() => {
    Keyboard.dismiss();
    setDrafts({ task: '', waiting: '', after: '', project: '' });
    setIgnoredSchedule(null);
    setConfirmingDiscard(false);
    setAdding(false);
    setAddDate(null);
    setAddProjectId(null);
    setSchedulingAdd(false);
    setPickingProject(false);
    setPickingAfter(false);
    setMode(modes[0] ?? 'task');
    onClosed?.();
  }, [modes, onClosed]);

  const open = useCallback(
    (options?: { initialMode?: AddMode; projectId?: string }) => {
      defaultToastController.dismiss();
      const initialMode =
        options?.initialMode && modes.includes(options.initialMode)
          ? options.initialMode
          : (modes[0] ?? 'task');
      setMode(initialMode);
      setAddProjectId(options?.projectId ?? contextProjectId);
      setAdding(true);
      setPickingAfter(initialMode === 'after');
    },
    [modes, contextProjectId],
  );

  const selectMode = useCallback(
    (nextMode: AddMode) => {
      setMode(nextMode);
      if (nextMode === 'task' && contextProjectId) {
        setAddProjectId(contextProjectId);
      }
      if (nextMode === 'after') setPickingAfter(true);
    },
    [contextProjectId],
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
      const tx = projectsApi.add(trimmed);
      tx.isPersisted.promise.catch((error) => onError(messageOf(error)));
      const id = String(tx.mutations[0]?.key);
      void requestIconSuggestions(getToken, id, {
        title: trimmed,
        description: null,
      });
      if (onProjectCreated) {
        closeAdd();
        onProjectCreated(id);
        return;
      }
      toast('Project created', {
        description: `${DEFAULT_ICON} ${trimmed}`,
        action: {
          label: 'View',
          onPress: () =>
            router.navigate(`/projects/${id}`, { withAnchor: true }),
        },
      });
      closeAdd();
      return;
    }

    const taskText = effectiveText.trim();
    if (!taskText) return;
    defaultToastController.dismiss();
    const tx = tasksApi.add(
      taskText,
      effectiveDate,
      addProjectId,
      null,
      effectiveRecurrence,
    );
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
    getToken,
    onProjectCreated,
    effectiveText,
    tasksApi,
    effectiveDate,
    addProjectId,
    effectiveRecurrence,
    contextProjectId,
    projects,
  ]);

  const requestClose = useCallback(() => {
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
    } else if (hasDraft) {
      setConfirmingDiscard(true);
    } else {
      closeAdd();
    }
  }, [confirmingDiscard, hasDraft, closeAdd]);

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
      {showFab && !adding ? (
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 bottom-0 items-end px-screen-x pb-6"
        >
          <Fab label={fabLabel} onPress={() => open()} />
        </View>
      ) : null}

      <TaskEditorSheet
        open={adding}
        onClose={requestClose}
        dismissLabel="Dismiss quick add"
        draft={text}
        onChangeDraft={setText}
        highlightRanges={
          mode === 'task'
            ? parsedSchedule.kind === 'scheduled'
              ? parsedSchedule.consumed
              : []
            : undefined
        }
        onDismissHighlight={ignoreScheduleRange}
        onSubmit={onAdd}
        placeholder={ADD_MODE_PLACEHOLDER[mode]}
        autoFocus={mode !== 'after'}
        inline
        inputRef={inputRef}
        inputAccessibilityLabel={mode === 'waiting' ? 'Waiting on' : undefined}
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
                label: effectiveRecurrence
                  ? toText(effectiveRecurrence)
                  : effectiveDate
                    ? scheduleLabel(effectiveDate, today)
                    : 'No date',
                active: effectiveDate != null,
                onPress: () => setSchedulingAdd(true),
                trailingAction:
                  parsedSchedule.kind === 'scheduled'
                    ? {
                        icon: <Text className="text-[20px]">×</Text>,
                        accessibilityLabel: 'Keep schedule words in task title',
                        onPress: () => {
                          const range = parsedSchedule.consumed[0];
                          if (range) ignoreScheduleRange(range);
                        },
                        testID: 'quick-add-unrecognize-schedule',
                      }
                    : undefined,
              }
            : undefined
        }
        projectAction={
          taskActionsVisible
            ? {
                label: selectedProject ? selectedProject.title : 'No project',
                icon: selectedProject?.icon ?? null,
                active: addProjectId != null,
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

      <ScheduleSheet
        open={schedulingAdd}
        showUpDate={addDate}
        onPick={(date) => {
          if (parsedSchedule.kind === 'scheduled') {
            setDrafts((current) => ({ ...current, task: effectiveText }));
            setIgnoredSchedule({
              text: effectiveText,
              ranges: effectiveText
                ? [{ start: 0, end: effectiveText.length, text: effectiveText }]
                : [],
            });
          }
          setAddDate(date);
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
          setAddProjectId(id);
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
      confirmingDiscard,
  };
}
