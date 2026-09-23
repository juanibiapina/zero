import {
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
import { toText } from '@zeroapps/recurrence';
import { Host, Icon } from '@expo/ui';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FlatList, Keyboard, Modal, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';

import { TaskEditorSheet } from '@/components/task-editor-sheet';
import { Input } from '@/components/ui/input';
import { CheckCircle } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useLocalDay } from '@/lib/local-day';
import { useColor } from '@/lib/theme';
import { showTaskDestination } from '@/lib/task-feedback';

const OPEN_PROJECT_ICON = Icon.select({
  ios: 'arrow.up.right',
  android: import('@expo/material-symbols/arrow_outward.xml'),
});

// The project picker: a bounded, keyboard-docked React Native modal with a
// title filter and a pinned "No project" row (move back to loose). Mounting only
// while open resets the filter between task edits and quick-add drafts.
type ProjectPickerSheetProps = {
  open: boolean;
  title?: string;
  projects: Project[];
  selectedProjectId: string | null;
  showNoProject?: boolean;
  emptyCopy?: string;
  onPick: (projectId: string | null) => void;
  onClose: () => void;
};

export function ProjectPickerSheet(props: ProjectPickerSheetProps) {
  return props.open ? <OpenProjectPickerSheet {...props} /> : null;
}

function OpenProjectPickerSheet({
  open,
  projects,
  selectedProjectId,
  onPick,
  onClose,
  title = 'Move to project',
  showNoProject = true,
  emptyCopy,
}: ProjectPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [filter, setFilter] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () =>
      setKeyboardHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const needle = filter.trim().toLowerCase();
  const filteredProjects = useMemo(
    () =>
      needle
        ? projects.filter((project) =>
            project.title.toLowerCase().includes(needle),
          )
        : projects,
    [needle, projects],
  );
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close project picker"
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <KeyboardStickyView
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
      >
      <View
        style={{
          paddingBottom: insets.bottom + 8,
          maxHeight: Math.max(
            200,
            height - keyboardHeight - insets.top - 48,
          ),
        }}
        className="rounded-t-2xl bg-surface pt-2 shadow-raised"
      >
        <View className="mb-1 h-1 w-9 self-center rounded-full bg-divider" />
        <Text className="px-screen-x pb-1 pt-2 text-[15px] font-semibold">
          {title}
        </Text>

        <View className="mx-screen-x my-2 min-h-12 justify-center rounded-xl bg-background px-3">
          <Input
            value={filter}
            onChangeText={setFilter}
            placeholder="Filter projects"
            accessibilityLabel="Filter projects"
            autoCorrect={false}
            returnKeyType="search"
            className="min-h-12"
            testID="project-filter"
          />
        </View>

        {showNoProject ? (
          <QuickRow
            icon="⊘"
            label="No project"
            onPress={() => onPick(null)}
            testID="project-none"
            selected={selectedProjectId == null}
          />
        ) : null}

        <FlatList
          style={{ flexShrink: 1 }}
          className="border-t border-divider"
          data={filteredProjects}
          keyExtractor={(p) => p.id}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            needle || emptyCopy ? (
              <Text className="px-screen-x py-4 text-foreground-secondary">
                {needle ? 'No matching projects' : emptyCopy}
              </Text>
            ) : null
          }
          renderItem={({ item: p }) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityLabel={p.title}
              accessibilityState={{ selected: p.id === selectedProjectId }}
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
              {p.id === selectedProjectId ? <Text importantForAccessibility="no">✓</Text> : null}
            </Pressable>
          )}
        />
      </View>
      </KeyboardStickyView>
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
  selected,
}: {
  icon: string;
  label: string;
  hint?: string;
  onPress: () => void;
  testID?: string;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      testID={testID}
      onPress={onPress}
      className="flex-row items-center gap-3 px-screen-x py-3"
    >
      <Text className="w-6 text-center text-[18px]">{icon}</Text>
      <Text className="flex-1 text-[16px]">{label}</Text>
      {selected ? <Text importantForAccessibility="no">✓</Text> : null}
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
type ScheduleSheetProps = {
  open: boolean;
  showUpDate: string | null | undefined;
  recurrenceLabel?: string;
  onStopRecurrence?: () => void;
  onCompleteForever?: () => void;
  onPick: (date: string | null) => void;
  onClose: () => void;
};

export function ScheduleSheet(props: ScheduleSheetProps) {
  return props.open ? <OpenScheduleSheet {...props} /> : null;
}

function OpenScheduleSheet({
  open,
  showUpDate,
  recurrenceLabel,
  onStopRecurrence,
  onCompleteForever,
  onPick,
  onClose,
}: ScheduleSheetProps) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const accent = useColor('--color-accent');
  const onAccent = useColor('--color-on-accent');
  const today = useLocalDay();
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
        style={{ paddingBottom: insets.bottom + 8, maxHeight: height - insets.top - 48 }}
        className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface pt-2 shadow-raised"
      >
        <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
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
          selected={selected === today}
        />
        <QuickRow
          icon="⏭"
          label="Tomorrow"
          hint={weekdayShort(tmr)}
          onPress={() => onPick(tmr)}
          testID="schedule-tomorrow"
          selected={selected === tmr}
        />

        {/* Inline month calendar */}
        <View className="mt-2 border-t border-divider px-screen-x pt-3">
          <View className="flex-row items-center justify-between pb-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              className="min-h-12 min-w-12 items-center justify-center"
              hitSlop={8}
              onPress={() => step(-1)}
            >
              <Text className="text-[20px] text-foreground-secondary">‹</Text>
            </Pressable>
            <Text className="text-[14px] font-medium">{monthTitle}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next month"
              className="min-h-12 min-w-12 items-center justify-center"
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
                    accessibilityLabel={new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(new Date(`${date}T12:00:00`))}
                    accessibilityState={{ selected: isSelected }}
                    accessibilityHint={isToday ? 'Today' : undefined}
                    testID={`schedule-date-${date}`}
                    onPress={() => onPick(date)}
                    className="min-h-12 flex-1 items-center justify-center py-1"
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

        {recurrenceLabel && onStopRecurrence ? (
          <View className="mt-2 border-t border-divider">
            <QuickRow
              icon="↻"
              label={`Stop ${recurrenceLabel}`}
              onPress={onStopRecurrence}
              testID="schedule-stop-recurrence"
            />
            {onCompleteForever ? (
              <QuickRow
                icon="✓"
                label="Complete forever"
                onPress={onCompleteForever}
                testID="schedule-complete-forever"
              />
            ) : null}
          </View>
        ) : null}
        <View className="mt-2 border-t border-divider">
          <QuickRow
            icon="⊘"
            label="No date"
            onPress={() => onPick(null)}
            testID="schedule-none"
            selected={selected == null}
          />
        </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// The task detail editor as one deep module: it owns the drawer, schedule and
// project pickers, project navigation, and their state and writes behind a small
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
  // The detail sheet + schedule/project pickers, ready to render at the screen root.
  sheets: ReactNode;
  // Consume an Android Back press when the editor or a picker is open. Returns
  // true if it handled the press (the screen should then return true too).
  handleBack: () => boolean;
  // Whether the editor or either picker is currently open.
  active: boolean;
};

export function useTaskDetail({
  api,
  list,
  projects,
  currentProjectId,
  onAddWaiting,
  onError,
}: {
  api: TasksApi;
  list: Task[];
  // The user's projects, for the move-to-project picker and the row's label.
  projects: Project[];
  // The project route already open behind this editor, when there is one.
  currentProjectId?: string | null;
  // Project-task completion delegates contextual Waiting creation to the one
  // Project add module mounted by the host screen.
  onAddWaiting: (project: Project) => void;
  // Each screen passes its own write-error setter (clears on null).
  onError: (message: string | null) => void;
}): TaskDetail {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [picking, setPicking] = useState(false);
  const today = useLocalDay();
  const projectJumpColor = useColor('--color-accent');
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

  const openSelectedProject = useCallback(() => {
    if (!selectedProject) return;
    commitDraft();
    closingDetailRef.current = true;
    setSelectedId(null);
    router.navigate(`/projects/${selectedProject.id}`, { withAnchor: true });
  }, [commitDraft, selectedProject]);

  const complete = useCallback(
    (item: Task) => {
      onError(null);
      const project = item.projectId
        ? projects.find((candidate) => candidate.id === item.projectId)
        : null;
      undoableAction({
        message: 'Completed',
        description: project ? `${project.icon} ${project.title}` : undefined,
        descriptionAction: project
          ? {
              accessibilityLabel: `Open project ${project.title}`,
              onPress: () =>
                router.navigate(`/projects/${project.id}`, { withAnchor: true }),
            }
          : undefined,
        secondaryAction: project
          ? {
              label: 'Waiting…',
              accessibilityLabel: `Add waiting condition to ${project.title}`,
              onPress: () => onAddWaiting(project),
            }
          : undefined,
        act: () => api.complete(item.id, today),
        undo: () =>
          item.recurrence
            ? api.undoOccurrence(item, today)
            : api.reopen(item),
        onError,
      });
    },
    [api, onAddWaiting, onError, projects, today],
  );

  const completeFromSheet = useCallback(() => {
    const item = commitDraft();
    if (!item) return;
    setSelectedId(null);
    complete(item);
  }, [commitDraft, complete]);

  const onPickSchedule = useCallback(
    (date: string | null) => {
      if (selected && selected.showUpDate !== date) {
        onError(null);
        const tx = api.reschedule(selected.id, date);
        tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
        setSelectedId(null);
      }
      setScheduling(false);
    },
    [api, selected, onError],
  );

  const stopRecurrence = useCallback(() => {
    if (!selected?.recurrence) return;
    onError(null);
    const tx = api.setRecurrence(selected.id, null);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    setScheduling(false);
  }, [api, selected, onError]);

  const completeForever = useCallback(() => {
    if (!selected?.recurrence) return;
    const item = selected;
    setScheduling(false);
    setSelectedId(null);
    undoableAction({
      message: 'Completed forever',
      act: () => api.completeForever(item.id),
      undo: () => api.reopen(item),
      onError,
    });
  }, [api, selected, onError]);

  const onPickProject = useCallback(
    (projectId: string | null) => {
      if (selected && selected.projectId !== projectId) {
        onError(null);
        const tx = api.moveToProject(selected.id, projectId);
        tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
        setSelectedId(null);
        showTaskDestination({ ...selected, projectId }, projects, 'moved');
      }
      setPicking(false);
    },
    [api, selected, projects, onError],
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
                label: selected.recurrence
                  ? toText(selected.recurrence)
                  : selected.showUpDate
                    ? scheduleLabel(selected.showUpDate, today)
                    : 'No date',
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
                trailingAction:
                  selectedProject && selectedProject.id !== currentProjectId
                    ? {
                        icon: (
                          <Host matchContents>
                            <Icon
                              name={OPEN_PROJECT_ICON}
                              size={20}
                              color={projectJumpColor}
                            />
                          </Host>
                        ),
                        accessibilityLabel: `Open project ${selectedProject.title}`,
                        onPress: openSelectedProject,
                        testID: 'task-project-open',
                      }
                    : undefined,
              }
            : undefined
        }
      />

      <ScheduleSheet
        key={selected?.id ?? 'none'}
        open={scheduling && selected != null}
        showUpDate={selected?.showUpDate}
        recurrenceLabel={selected?.recurrence ? toText(selected.recurrence) : undefined}
        onStopRecurrence={selected?.recurrence ? stopRecurrence : undefined}
        onCompleteForever={selected?.recurrence ? completeForever : undefined}
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
