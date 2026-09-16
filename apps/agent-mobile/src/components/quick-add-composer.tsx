import {
  ADD_MODE_PLACEHOLDER,
  messageOf,
  scheduleLabel,
  toast,
  type AddMode,
  type Project,
  type ProjectsApi,
  type TasksApi,
} from '@zero/agent-core';
import {
  parseSchedule,
  toText,
  type TextRange,
} from '@zeroapps/recurrence';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { ProjectPickerSheet, ScheduleSheet } from '@/components/task-detail';
import { AddModeSelector, TaskEditorSheet } from '@/components/task-editor-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Fab } from '@/components/ui/fab';
import { Text } from '@/components/ui/text';
import { requestIconSuggestions } from '@/lib/icon-suggestions';
import { useLocalDay } from '@/lib/local-day';
import { type TokenGetter } from '@/lib/api';
import { showTaskDestination } from '@/lib/task-feedback';

// The quick-add composer as one deep module: it owns the whole add surface — the
// collapsed FAB, the create bottom drawer with its mode selector, the create-time
// date and project rows, the schedule/project picker sheets, the discard-confirm
// dialog, and the per-mode write logic — behind a small interface. Home and a
// project's own screen render the same composer through this hook instead of each
// reimplementing it. It renders the SHARED `TaskEditorSheet` (the same
// bottom-drawer edit opens), so create and edit look identical; the differences
// (mode selector, a submit button, no complete circle) are passed as slots. Sibling
// in spirit to useTaskDetail. See docs/plans/todo-unify-task-editor-drawer.md.
//
// Because the drawer is an RN Modal (not an in-screen keyboard bar), the keyboard
// hiding no longer closes it, so the old keyboard-hide close-race guard is gone;
// dismissal is a scrim tap or Back, which raises the discard-confirm over unsaved
// text.
//
// A `projectId` presets a Task's project row (still changeable — you can move
// the new Task to another Project or make it loose), and filing a dateless Task
// to it fires no "Filed to project" toast because it appears on that workspace.
// With no
// `projectId` (Home) the row starts on "No project". Either way the row is shown
// in task mode.
export type QuickAddController = {
  // The FAB + create drawer + all composer sheets + the discard dialog, rendered
  // at the screen root.
  bar: ReactNode;
  // Consume one Android Back press: close the discard dialog, raise it over
  // unsaved text, or close the drawer. Returns true when it handled the press.
  handleBack: () => boolean;
  // Whether the drawer or any of its sheets/dialogs is open.
  active: boolean;
  open: () => void;
};

export function useQuickAdd({
  tasksApi,
  projectsApi,
  projects,
  modes,
  projectId,
  getToken,
  onError,
  fabLabel,
  onProjectCreated,
  showFab = true,
}: {
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
  // The user's projects, for the project row label and the "Filed" toast copy.
  projects: Project[];
  // Which Task/Project mode tabs to offer, in order.
  modes: AddMode[];
  // This screen's home project (a project's own screen): presets the project
  // row to it (still changeable) and scopes a waiting add to it. Omit/null on
  // Home (the row starts on "No project").
  projectId?: string | null;
  // For warming a freshly created project's icon suggestions (project mode).
  getToken: TokenGetter;
  // Each screen passes its own write-error setter (clears on null).
  onError: (message: string | null) => void;
  // Wording of the collapsed FAB and its accessibility label.
  fabLabel: string;
  onProjectCreated?: (id: string) => void;
  showFab?: boolean;
}): QuickAddController {
  const [text, setText] = useState('');
  const [ignoredSchedule, setIgnoredSchedule] = useState<{
    text: string;
    ranges: TextRange[];
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<AddMode>(modes[0] ?? 'task');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // Create-time date + project for a task quick-add. Both default to "unset":
  // null date + no project = a loose Home task. Reset when the drawer closes.
  const [addDate, setAddDate] = useState<string | null>(null);
  // The project row is preset to the screen's home project (`projectId`), so a
  // project-screen task defaults to that project; Home starts on "No project".
  const [addProjectId, setAddProjectId] = useState<string | null>(
    projectId ?? null,
  );
  const [schedulingAdd, setSchedulingAdd] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const inputRef = useRef<{ focus: () => void }>(null);

  // The screen's home project, normalized (Home passes none).
  const contextProjectId = projectId ?? null;
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
  const ignoreScheduleRange = (range: TextRange) => {
    setIgnoredSchedule((current) => ({
      text,
      ranges:
        current?.text === text ? [...current.ranges, range] : [range],
    }));
  };

  const closeAdd = useCallback(() => {
    setText('');
    setIgnoredSchedule(null);
    setConfirmingDiscard(false);
    setAdding(false);
    setAddDate(null);
    // Next open starts preset to the screen's project again.
    setAddProjectId(contextProjectId);
    setSchedulingAdd(false);
    setPickingProject(false);
    // Next open starts on the common case.
    setMode(modes[0] ?? 'task');
  }, [modes, contextProjectId]);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Reset metadata as well, so the next draft starts clean.
      closeAdd();
      return;
    }
    onError(null);

    if (mode === 'project') {
      // Create the project but stay put; a toast is the escape hatch to jump to
      // it. The id comes off the optimistic insert so the toast can deep-link
      // before the server round-trip finishes.
      const tx = projectsApi.add(trimmed);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
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
        description: trimmed,
        action: {
          label: 'View',
          onPress: () =>
            router.navigate(`/projects/${id}`, { withAnchor: true }),
        },
      });
      closeAdd();
      return;
    }

    // Task mode. The task attaches to the project chosen in the row (preset to
    // this screen's project, changeable). No project + null date = a loose Home
    // task; a date
    // makes it a Home/Upcoming task; a project with no date files it groomed (off
    // Home). A dateless task filed to a project OTHER than this screen's own —
    // i.e. it will not appear right here — is explained by a "Filed to project"
    // toast so nothing vanishes silently; filing to this screen's own project
    // stays quiet (it lands in the Tasks section below).
    const effectiveProjectId = addProjectId;
    const taskText = effectiveText.trim();
    if (!taskText) return;
    const tx = tasksApi.add(
      taskText,
      effectiveDate,
      effectiveProjectId,
      null,
      effectiveRecurrence,
    );
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    if (
      (contextProjectId == null && effectiveDate != null && effectiveDate > today) ||
      (effectiveProjectId != null && effectiveProjectId !== contextProjectId)
    ) {
      showTaskDestination(
        { showUpDate: effectiveDate, projectId: effectiveProjectId },
        projects,
        'created',
      );
    }
    closeAdd();
  }, [
    text,
    mode,
    effectiveDate,
    effectiveRecurrence,
    effectiveText,
    addProjectId,
    contextProjectId,
    today,
    projects,
    tasksApi,
    projectsApi,
    getToken,
    onError,
    closeAdd,
    onProjectCreated,
  ]);

  // Scrim tap or Back over unsaved text raises the discard confirm; empty, it
  // just closes. The drawer is a Modal, so the keyboard hiding never closes it —
  // there is no keyboard-hide race to guard against anymore.
  const requestClose = useCallback(() => {
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
    } else if (text.trim()) {
      setConfirmingDiscard(true);
    } else {
      closeAdd();
    }
  }, [confirmingDiscard, text, closeAdd]);

  const handleBack = useCallback(() => {
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
      return true;
    }
    if (adding && text.trim()) {
      setConfirmingDiscard(true);
      return true;
    }
    if (adding) {
      closeAdd();
      return true;
    }
    return false;
  }, [confirmingDiscard, adding, text, closeAdd]);

  // Date and project rows belong to Task mode only; Project creates no Task,
  // so it shows the mode selector, text, and submit action without Task
  // metadata. The project row stays changeable when preset by a project screen.
  const taskActionsVisible = mode === 'task';
  const selectedProject = projects.find((p) => p.id === addProjectId) ?? null;

  const bar = (
    <>
      {/* Collapsed entry: the FAB, pinned bottom-right; box-none lets taps
          through to the list everywhere except the FAB. Tapping it opens the
          drawer. */}
      {showFab && !adding ? (
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 bottom-0 items-end px-screen-x pb-6"
        >
          <Fab label={fabLabel} onPress={() => setAdding(true)} />
        </View>
      ) : null}

      <TaskEditorSheet
        open={adding}
        onClose={requestClose}
        dismissLabel="Dismiss quick add"
        draft={text}
        onChangeDraft={(next) => {
          setText(next);
          if (next !== ignoredSchedule?.text) setIgnoredSchedule(null);
        }}
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
        autoFocus
        inputRef={inputRef}
        modeSelector={
          modes.length > 1 ? (
            <AddModeSelector mode={mode} modes={modes} onModeChange={setMode} />
          ) : undefined
        }
        trailing={
          <Fab
            label={fabLabel}
            size="sm"
            disabled={text.trim().length === 0}
            onPress={onAdd}
          />
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
        onPick={(d) => {
          if (parsedSchedule.kind === 'scheduled') {
            setText(effectiveText);
            setIgnoredSchedule({
              text: effectiveText,
              ranges: effectiveText
                ? [{ start: 0, end: effectiveText.length, text: effectiveText }]
                : [],
            });
          }
          setAddDate(d);
          setSchedulingAdd(false);
        }}
        onClose={() => setSchedulingAdd(false)}
      />

      <ProjectPickerSheet
        title="Project"
        open={pickingProject}
        projects={projects}
        selectedProjectId={addProjectId}
        onPick={(id) => {
          setAddProjectId(id);
          setPickingProject(false);
        }}
        onClose={() => setPickingProject(false)}
      />
    </>
  );

  return {
    bar,
    open: () => setAdding(true),
    handleBack,
    active: adding || schedulingAdd || pickingProject || confirmingDiscard,
  };
}
