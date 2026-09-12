import {
  DEFAULT_ICON,
  localToday,
  messageOf,
  scheduleLabel,
  toast,
  type AddMode,
  type Project,
  type ProjectsApi,
  type TasksApi,
  type WaitsApi,
} from '@zero/agent-core';
import { router } from 'expo-router';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { type TextInput as RNTextInput } from 'react-native';
import { KeyboardEvents } from 'react-native-keyboard-controller';

import { QuickAdd } from '@/components/quick-add';
import { ProjectPickerSheet, ScheduleSheet } from '@/components/task-detail';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { requestIconSuggestions } from '@/lib/icon-suggestions';
import { type TokenGetter } from '@/lib/api';

// The quick-add composer as one deep module: it owns the whole add surface — the
// collapsed FAB, the expanded bar with its mode pills, the create-time date and
// project chips, the schedule/project picker sheets, the discard-confirm dialog,
// the keyboard-hide close race, and the per-mode write logic — behind a small
// interface. Home and a project's own screen render the same composer through
// this hook instead of each reimplementing it (they had already drifted: only
// Home carried the date/project chips and discard-confirm). Sibling in spirit to
// useTaskDetail. See docs/plans/todo-project-task-edit-and-shared-add.md.
//
// A fixed `projectId` (a project's own screen) makes the composer project-scoped:
// the project chip is hidden (there is nothing to pick), a new task attaches to
// that project, a `waiting` add records a free-text condition on it, and no
// "Filed to project" toast fires (you are already on it). With no `projectId`
// (Home) the project chip is shown and any project can be picked.
export type QuickAddController = {
  // The FAB + bar + all composer sheets + the discard dialog, rendered at the
  // screen root.
  bar: ReactNode;
  // Consume one Android Back press: close the discard dialog, raise it over
  // unsaved text, or close the bar. Returns true when it handled the press.
  handleBack: () => boolean;
  // Whether the bar or any of its sheets/dialogs is open.
  active: boolean;
};

export function useQuickAdd({
  tasksApi,
  projectsApi,
  waitsApi,
  projects,
  modes,
  projectId,
  bottomOffset,
  getToken,
  onError,
  fabLabel,
}: {
  tasksApi: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
  // The user's projects, for the project chip label and the "Filed" toast copy.
  projects: Project[];
  // Which mode pills to offer, in order. Home: ['task','project']; a project's
  // own screen: ['task','waiting'].
  modes: AddMode[];
  // A fixed project context (a project's own screen); omit/null on Home.
  projectId?: string | null;
  // Distance (dp) from the screen's content bottom to the window bottom, so the
  // keyboard-sticky bar docks flush to the keyboard.
  bottomOffset: number;
  // For warming a freshly created project's icon suggestions (project mode).
  getToken: TokenGetter;
  // Each screen passes its own write-error setter (clears on null).
  onError: (message: string | null) => void;
  // Wording of the collapsed FAB and its accessibility label.
  fabLabel: string;
}): QuickAddController {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<AddMode>(modes[0] ?? 'task');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // Create-time date + project for a task quick-add. Both default to "unset":
  // null date + no project = a loose Home task. Reset when the bar closes.
  const [addDate, setAddDate] = useState<string | null>(null);
  const [addProjectId, setAddProjectId] = useState<string | null>(null);
  const [schedulingAdd, setSchedulingAdd] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  // Opening/closing a composer picker dismisses the keyboard, which would fire
  // keyboardDidHide and close the whole bar. The flags guard the open; this
  // suppression window absorbs the CLOSE race, where keyboardDidHide fires just
  // after the flag is cleared. Epoch ms until which keyboard-hide close is
  // suppressed.
  const suppressKbCloseUntil = useRef(0);
  const inputRef = useRef<RNTextInput>(null);

  // A fixed project context hides the project chip (nothing to pick).
  const fixedProject = projectId != null;
  const today = localToday();

  const closeAdd = useCallback(() => {
    setText('');
    setConfirmingDiscard(false);
    setAdding(false);
    setAddDate(null);
    setAddProjectId(null);
    setSchedulingAdd(false);
    setPickingProject(false);
    // Next open starts on the common case.
    setMode(modes[0] ?? 'task');
  }, [modes]);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Submitting an empty input closes the bar.
      setAdding(false);
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

    if (mode === 'waiting') {
      // Waiting mode records a free-text waiting condition on the fixed project.
      if (projectId == null) return;
      const tx = waitsApi.add(projectId, 'free-text', { text: trimmed });
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
      closeAdd();
      return;
    }

    // Task mode. A fixed project wins; otherwise the composer's picked project.
    // No project + null date = a loose Home task; a date makes it a Home/Upcoming
    // task; a project with no date files it groomed (off Home). On Home a filed
    // dateless task is explained by a toast so nothing vanishes silently; on a
    // project's own screen no toast fires (you are already on it).
    const effectiveProjectId = projectId ?? addProjectId;
    const tx = tasksApi.add(trimmed, addDate, effectiveProjectId);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    if (!fixedProject && addProjectId != null && addDate == null) {
      const project = projects.find((p) => p.id === addProjectId);
      toast('Filed to project', {
        description: project
          ? `${project.icon ?? DEFAULT_ICON} ${project.title}`
          : undefined,
      });
    }
    closeAdd();
  }, [
    text,
    mode,
    projectId,
    addDate,
    addProjectId,
    fixedProject,
    projects,
    tasksApi,
    projectsApi,
    waitsApi,
    getToken,
    onError,
    closeAdd,
  ]);

  const requestClose = useCallback(() => {
    if (text.trim()) {
      setConfirmingDiscard(true);
    } else {
      closeAdd();
    }
  }, [text, closeAdd]);

  // The keyboard hiding closes an empty bar and raises the discard confirm over
  // unsaved text — but not when a composer picker is open (that dismissal is
  // deliberate and the bar reopens the keyboard when the picker closes).
  useEffect(() => {
    const sub = KeyboardEvents.addListener('keyboardDidHide', () => {
      if (!adding || confirmingDiscard) return;
      if (schedulingAdd || pickingProject) return;
      if (Date.now() < suppressKbCloseUntil.current) return;
      if (text.trim()) {
        setConfirmingDiscard(true);
      } else {
        closeAdd();
      }
    });
    return () => sub.remove();
  }, [adding, confirmingDiscard, text, closeAdd, schedulingAdd, pickingProject]);

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

  // Date/project chips belong to task mode only. The project chip is further
  // gated to the free (non-fixed) context.
  const showDateChip = mode === 'task';
  const showProjectChip = mode === 'task' && !fixedProject;

  const bar = (
    <>
      <QuickAdd
        open={adding}
        text={text}
        mode={mode}
        modes={modes}
        onModeChange={setMode}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={onAdd}
        onRequestClose={requestClose}
        busy={false}
        inputRef={inputRef}
        fabLabel={fabLabel}
        dateChipLabel={
          showDateChip
            ? addDate
              ? scheduleLabel(addDate, today)
              : 'No date'
            : undefined
        }
        dateChipActive={addDate != null}
        onDateChipPress={showDateChip ? () => setSchedulingAdd(true) : undefined}
        projectChipLabel={
          showProjectChip
            ? (projects.find((p) => p.id === addProjectId)?.title ??
              'No project')
            : undefined
        }
        projectChipActive={addProjectId != null}
        onProjectChipPress={
          showProjectChip ? () => setPickingProject(true) : undefined
        }
        bottomOffset={bottomOffset}
      />

      <ScheduleSheet
        open={schedulingAdd}
        showUpDate={addDate}
        onPick={(d) => {
          suppressKbCloseUntil.current = Date.now() + 1000;
          setAddDate(d);
          setSchedulingAdd(false);
        }}
        onClose={() => {
          suppressKbCloseUntil.current = Date.now() + 1000;
          setSchedulingAdd(false);
        }}
      />

      {!fixedProject ? (
        <ProjectPickerSheet
          open={pickingProject}
          projects={projects}
          selectedProjectId={addProjectId}
          onPick={(id) => {
            suppressKbCloseUntil.current = Date.now() + 1000;
            setAddProjectId(id);
            setPickingProject(false);
          }}
          onClose={() => {
            suppressKbCloseUntil.current = Date.now() + 1000;
            setPickingProject(false);
          }}
        />
      ) : null}

      {confirmingDiscard ? (
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
      ) : null}
    </>
  );

  return {
    bar,
    handleBack,
    active: adding || schedulingAdd || pickingProject || confirmingDiscard,
  };
}
