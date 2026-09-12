import {
  ADD_MODE_PLACEHOLDER,
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
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { ProjectPickerSheet, ScheduleSheet } from '@/components/task-detail';
import { ModePills, TaskEditorSheet } from '@/components/task-editor-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Fab } from '@/components/ui/fab';
import { requestIconSuggestions } from '@/lib/icon-suggestions';
import { type TokenGetter } from '@/lib/api';

// The quick-add composer as one deep module: it owns the whole add surface — the
// collapsed FAB, the create bottom drawer with its mode pills, the create-time
// date and project chips, the schedule/project picker sheets, the discard-confirm
// dialog, and the per-mode write logic — behind a small interface. Home and a
// project's own screen render the same composer through this hook instead of each
// reimplementing it. It renders the SHARED `TaskEditorSheet` (the same
// bottom-drawer edit opens), so create and edit look identical; the differences
// (mode pills, a submit button, no complete circle) are passed as slots. Sibling
// in spirit to useTaskDetail. See docs/plans/todo-unify-task-editor-drawer.md.
//
// Because the drawer is an RN Modal (not an in-screen keyboard bar), the keyboard
// hiding no longer closes it, so the old keyboard-hide close-race guard is gone;
// dismissal is a scrim tap or Back, which raises the discard-confirm over unsaved
// text.
//
// A `projectId` (a project's own screen) is the composer's home project: it
// presets the project chip to that project (still changeable — you can move the
// new task to another project or make it loose), a `waiting` add records a
// free-text condition on it, and filing a dateless task to it fires no "Filed to
// project" toast (it appears right there in the project's Tasks). With no
// `projectId` (Home) the chip starts on "No project". Either way the chip is
// shown in task mode.
export type QuickAddController = {
  // The FAB + create drawer + all composer sheets + the discard dialog, rendered
  // at the screen root.
  bar: ReactNode;
  // Consume one Android Back press: close the discard dialog, raise it over
  // unsaved text, or close the drawer. Returns true when it handled the press.
  handleBack: () => boolean;
  // Whether the drawer or any of its sheets/dialogs is open.
  active: boolean;
};

export function useQuickAdd({
  tasksApi,
  projectsApi,
  waitsApi,
  projects,
  modes,
  projectId,
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
  // This screen's home project (a project's own screen): presets the project
  // chip to it (still changeable) and scopes a waiting add to it. Omit/null on
  // Home (chip starts on "No project").
  projectId?: string | null;
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
  // null date + no project = a loose Home task. Reset when the drawer closes.
  const [addDate, setAddDate] = useState<string | null>(null);
  // The chip is preset to the screen's home project (`projectId`), so a
  // project-screen task defaults to that project; Home starts on "No project".
  const [addProjectId, setAddProjectId] = useState<string | null>(
    projectId ?? null,
  );
  const [schedulingAdd, setSchedulingAdd] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const inputRef = useRef<{ focus: () => void }>(null);

  // The screen's home project, normalized (Home passes none).
  const contextProjectId = projectId ?? null;
  const today = localToday();

  const closeAdd = useCallback(() => {
    setText('');
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
      // Waiting mode records a free-text waiting condition on this screen's own
      // project (a condition belongs to the project, so it is not the changeable
      // chip's target).
      if (projectId == null) return;
      const tx = waitsApi.add(projectId, 'free-text', { text: trimmed });
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
      closeAdd();
      return;
    }

    // Task mode. The task attaches to the chip's project (preset to this screen's
    // project, changeable). No project + null date = a loose Home task; a date
    // makes it a Home/Upcoming task; a project with no date files it groomed (off
    // Home). A dateless task filed to a project OTHER than this screen's own —
    // i.e. it will not appear right here — is explained by a "Filed to project"
    // toast so nothing vanishes silently; filing to this screen's own project
    // stays quiet (it lands in the Tasks section below).
    const effectiveProjectId = addProjectId;
    const tx = tasksApi.add(trimmed, addDate, effectiveProjectId);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    if (
      addDate == null &&
      effectiveProjectId != null &&
      effectiveProjectId !== contextProjectId
    ) {
      const project = projects.find((p) => p.id === effectiveProjectId);
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
    contextProjectId,
    projects,
    tasksApi,
    projectsApi,
    waitsApi,
    getToken,
    onError,
    closeAdd,
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

  // Date and project chips belong to task mode only; project/waiting create no
  // task, so they show pills + text + submit with no chips. The project chip is
  // always shown in task mode (preset to this screen's project, changeable).
  const chipsInMode = mode === 'task';
  const selectedProject = projects.find((p) => p.id === addProjectId) ?? null;

  const bar = (
    <>
      {/* Collapsed entry: the FAB, pinned bottom-right; box-none lets taps
          through to the list everywhere except the FAB. Tapping it opens the
          drawer. */}
      {!adding ? (
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
        onChangeDraft={setText}
        onSubmit={onAdd}
        placeholder={ADD_MODE_PLACEHOLDER[mode]}
        autoFocus
        inputRef={inputRef}
        pills={
          <ModePills mode={mode} modes={modes} onModeChange={setMode} />
        }
        trailing={
          <Fab
            label={fabLabel}
            size="sm"
            disabled={text.trim().length === 0}
            onPress={onAdd}
          />
        }
        dateChip={
          chipsInMode
            ? {
                label: addDate ? scheduleLabel(addDate, today) : 'No date',
                active: addDate != null,
                onPress: () => setSchedulingAdd(true),
              }
            : undefined
        }
        projectChip={
          chipsInMode
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
          setAddDate(d);
          setSchedulingAdd(false);
        }}
        onClose={() => setSchedulingAdd(false)}
      />

      <ProjectPickerSheet
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
    handleBack,
    active: adding || schedulingAdd || pickingProject || confirmingDiscard,
  };
}
