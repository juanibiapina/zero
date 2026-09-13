import {
  localToday,
  messageOf,
  monthMatrix,
  scheduleLabel,
  tomorrow,
  undoableAction,
  weekdayShort,
  type Project,
  type Task,
  type TasksApi,
} from '@zero/agent-core';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TaskEditorSheet } from '@/components/task-editor-sheet';
import { CheckCircle } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useColor } from '@/lib/theme';

// The project picker: a plain React Native modal listing the user's projects
// plus a "No project" row (move back to loose). Mirrors ScheduleSheet's shape.
// Exported so the Home quick-add composer can pick a project at create time.
export function ProjectPickerSheet({
  open,
  projects,
  selectedProjectId,
  onPick,
  onClose,
}: {
  open: boolean;
  projects: Project[];
  selectedProjectId: string | null;
  onPick: (projectId: string | null) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close project picker"
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <View
        style={{ paddingBottom: insets.bottom + 8 }}
        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface pt-2 shadow-raised"
      >
        <View className="mb-1 h-1 w-9 self-center rounded-full bg-divider" />
        <Text className="px-screen-x pb-1 pt-2 text-[15px] font-semibold">
          Move to project
        </Text>

        <QuickRow
          icon="⊘"
          label="No project"
          onPress={() => onPick(null)}
          testID="project-none"
        />

        <View className="border-t border-divider">
          {projects.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityLabel={p.title}
              testID={`project-${p.id}`}
              onPress={() => onPick(p.id)}
              className="flex-row items-center gap-3 px-screen-x py-3"
            >
              <Text className="w-6 text-center text-[18px]">{p.icon}</Text>
              <Text
                className={
                  p.id === selectedProjectId
                    ? 'flex-1 text-[16px] font-medium text-accent'
                    : 'flex-1 text-[16px]'
                }
              >
                {p.title}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

// One tappable quick-option row in the scheduler: an icon, a label, and the
// resolved weekday on the right (e.g. "Tomorrow · Fri"), mirroring Todoist.
function QuickRow({
  icon,
  label,
  hint,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  hint?: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      className="flex-row items-center gap-3 px-screen-x py-3"
    >
      <Text className="w-6 text-center text-[18px]">{icon}</Text>
      <Text className="flex-1 text-[16px]">{label}</Text>
      {hint ? (
        <Text className="text-[14px] text-foreground-secondary">{hint}</Text>
      ) : null}
    </Pressable>
  );
}

// The schedule selector: a plain React Native modal, NOT an @expo/ui tree, so it
// reproduces Todoist's scheduler — quick options with the resolved weekday on the
// right, an inline month calendar, and a "No date" row. It sets a task's
// showUpDate (a plain date; no time, no recurrence). Exported so task creation
// and editing open the same scheduler.
export function ScheduleSheet({
  open,
  showUpDate,
  onPick,
  onClose,
}: {
  open: boolean;
  showUpDate: string | null | undefined;
  onPick: (date: string | null) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const accent = useColor('--color-accent');
  const onAccent = useColor('--color-on-accent');
  const today = localToday();
  const tmr = tomorrow(today);
  const selected = showUpDate ?? null;

  // The month the grid shows: the selected date's month, else the current month.
  const initial = selected ?? today;
  const [y, m] = initial.split('-').map(Number);
  const [view, setView] = useState<{ y: number; m0: number }>({ y, m0: m - 1 });

  const grid = useMemo(() => monthMatrix(view.y, view.m0), [view]);
  const monthTitle = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: 'long',
        year: 'numeric',
      }).format(new Date(view.y, view.m0, 1)),
    [view],
  );
  const step = (delta: number) => {
    const d = new Date(view.y, view.m0 + delta, 1);
    setView({ y: d.getFullYear(), m0: d.getMonth() });
  };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close scheduler"
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <View
        style={{ paddingBottom: insets.bottom + 8 }}
        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface pt-2 shadow-raised"
      >
        <View className="mb-1 h-1 w-9 self-center rounded-full bg-divider" />
        <Text className="px-screen-x pb-1 pt-2 text-[15px] font-semibold">
          Schedule
        </Text>

        <QuickRow
          icon="🌤"
          label="Today"
          hint={weekdayShort(today)}
          onPress={() => onPick(today)}
          testID="schedule-today"
        />
        <QuickRow
          icon="⏭"
          label="Tomorrow"
          hint={weekdayShort(tmr)}
          onPress={() => onPick(tmr)}
          testID="schedule-tomorrow"
        />

        {/* Inline month calendar */}
        <View className="mt-2 border-t border-divider px-screen-x pt-3">
          <View className="flex-row items-center justify-between pb-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              hitSlop={8}
              onPress={() => step(-1)}
            >
              <Text className="text-[20px] text-foreground-secondary">‹</Text>
            </Pressable>
            <Text className="text-[14px] font-medium">{monthTitle}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next month"
              hitSlop={8}
              onPress={() => step(1)}
            >
              <Text className="text-[20px] text-foreground-secondary">›</Text>
            </Pressable>
          </View>
          <View className="flex-row pb-1">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <Text
                key={i}
                className="flex-1 text-center text-[12px] text-foreground-muted"
              >
                {d}
              </Text>
            ))}
          </View>
          {grid.map((week, wi) => (
            <View key={wi} className="flex-row">
              {week.map((date) => {
                const day = Number(date.split('-')[2]);
                const inMonth = Number(date.split('-')[1]) === view.m0 + 1;
                const isToday = date === today;
                const isSelected = date === selected;
                return (
                  <Pressable
                    key={date}
                    accessibilityRole="button"
                    accessibilityLabel={date}
                    onPress={() => onPick(date)}
                    className="flex-1 items-center py-1"
                  >
                    <View
                      style={
                        isSelected
                          ? { backgroundColor: accent }
                          : isToday
                            ? { borderWidth: 1, borderColor: accent }
                            : undefined
                      }
                      className="h-9 w-9 items-center justify-center rounded-full"
                    >
                      <Text
                        style={isSelected ? { color: onAccent } : undefined}
                        className={
                          inMonth
                            ? 'text-[15px] text-foreground'
                            : 'text-[15px] text-foreground-muted'
                        }
                      >
                        {day}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        <View className="mt-2 border-t border-divider">
          <QuickRow
            icon="⊘"
            label="No date"
            onPress={() => onPick(null)}
            testID="schedule-none"
          />
        </View>
      </View>
    </Modal>
  );
}

// The task detail editor as one deep module: it owns the detail sheet, the
// schedule selector, and all of their state and writes, behind a small
// interface. Home and Upcoming both open the same editor through this hook
// instead of duplicating ~200 lines of sheet markup.
//
// `list` is the screen's own visible list; the selected task is resolved as
// `list.find(id)`, so a reschedule that moves a task out of that list closes the
// sheet (Home drops a future-dated task; Upcoming drops one pulled to today).
// `handleBack` is returned, not self-registered, so each screen keeps its own
// Back priority (Home must still order quick-add and discard-confirm).
export type TaskDetail = {
  // Open the editor for a task (seeds the editable draft from its text).
  open: (item: Task) => void;
  // Complete a task with the shared single bottom Undo snackbar (shared 'undo'
  // id). Used by the sheet's check and by each screen's row checks, so the Undo
  // behavior lives in one place.
  complete: (item: Task) => void;
  // The detail sheet + schedule selector, ready to render at the screen root.
  sheets: ReactNode;
  // Consume an Android Back press when a sheet or the scheduler is open. Returns
  // true if it handled the press (the screen should then return true too).
  handleBack: () => boolean;
  // Whether a sheet or the scheduler is currently open.
  active: boolean;
};

export function useTaskDetail({
  api,
  list,
  projects,
  onError,
}: {
  api: TasksApi;
  list: Task[];
  // The user's projects, for the move-to-project picker and the row's label.
  projects: Project[];
  // Each screen passes its own write-error setter (clears on null).
  onError: (message: string | null) => void;
}): TaskDetail {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [picking, setPicking] = useState(false);
  const closingDetailRef = useRef(false);
  const selected = selectedId
    ? (list.find((item) => item.id === selectedId) ?? null)
    : null;
  const selectedProject = selected?.projectId
    ? (projects.find((p) => p.id === selected.projectId) ?? null)
    : null;

  const open = useCallback((item: Task) => {
    closingDetailRef.current = false;
    setDraft(item.text);
    setSelectedId(item.id);
  }, []);

  // Queue the title before opening another control. Waiting for the server here
  // would block offline use; the outbox preserves write order for this task.
  const commitDraft = useCallback((): Task | null => {
    if (!selected) return null;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === selected.text) return selected;
    onError(null);
    const tx = api.edit(selected.id, trimmed);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    return { ...selected, text: trimmed };
  }, [api, draft, selected, onError]);

  const commitAndClose = useCallback(() => {
    if (closingDetailRef.current) return;
    commitDraft();
    closingDetailRef.current = true;
    setSelectedId(null);
  }, [commitDraft]);

  const complete = useCallback(
    (item: Task) => {
      onError(null);
      // Single bottom Undo snackbar (shared 'undo' id, so only one shows at a
      // time). Undo reopens the task.
      undoableAction({
        message: 'Completed',
        act: () => api.complete(item.id),
        undo: () => api.reopen(item),
        onError,
      });
    },
    [api, onError],
  );

  const completeFromSheet = useCallback(() => {
    const item = commitDraft();
    if (!item) return;
    setSelectedId(null);
    complete(item);
  }, [commitDraft, complete]);

  const onPickSchedule = useCallback(
    (date: string | null) => {
      if (selected) {
        onError(null);
        const tx = api.reschedule(selected.id, date);
        tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
      }
      setScheduling(false);
    },
    [api, selected, onError],
  );

  const onPickProject = useCallback(
    (projectId: string | null) => {
      if (selected) {
        onError(null);
        const tx = api.moveToProject(selected.id, projectId);
        tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
      }
      setPicking(false);
    },
    [api, selected, onError],
  );

  const handleBack = useCallback(() => {
    if (picking) {
      setPicking(false);
      return true;
    }
    if (scheduling) {
      setScheduling(false);
      return true;
    }
    if (selected) {
      commitAndClose();
      return true;
    }
    return false;
  }, [picking, scheduling, selected, commitAndClose]);

  const sheets = (
    <>
      <TaskEditorSheet
        open={selected != null}
        onClose={commitAndClose}
        dismissLabel="Close task"
        draft={draft}
        onChangeDraft={setDraft}
        onSubmit={commitAndClose}
        autoFocus={false}
        leading={
          <CheckCircle label="Complete task" onPress={completeFromSheet} />
        }
        scheduleAction={
          selected
            ? {
                label: scheduleLabel(selected.showUpDate, localToday()),
                accessibilityLabel: 'Set schedule',
                active: selected.showUpDate != null,
                onPress: () => { commitDraft(); setScheduling(true); },
                testID: 'task-schedule',
              }
            : undefined
        }
        projectAction={
          selected
            ? {
                label: selectedProject ? selectedProject.title : 'No project',
                icon: selectedProject?.icon ?? null,
                accessibilityLabel: 'Set project',
                active: selectedProject != null,
                onPress: () => { commitDraft(); setPicking(true); },
                testID: 'task-project',
              }
            : undefined
        }
      />

      <ScheduleSheet
        key={selected?.id ?? 'none'}
        open={scheduling && selected != null}
        showUpDate={selected?.showUpDate}
        onPick={onPickSchedule}
        onClose={() => setScheduling(false)}
      />

      <ProjectPickerSheet
        open={picking && selected != null}
        projects={projects}
        selectedProjectId={selected?.projectId ?? null}
        onPick={onPickProject}
        onClose={() => setPicking(false)}
      />
    </>
  );

  return {
    open,
    complete,
    sheets,
    handleBack,
    active: selected != null || scheduling || picking,
  };
}
