import {
  capturesLocalToday,
  messageOf,
  monthMatrix,
  scheduleLabel,
  tomorrow,
  undoableAction,
  weekdayShort,
  type Capture,
  type CapturesApi,
} from '@zero/agent-core';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';

import { Input } from '@/components/ui/input';
import { CheckCircle } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { startRefine } from '@/lib/refine-session';
import { useColor } from '@/lib/theme';

// The capture detail: a plain React Native bottom sheet (an RN Modal + scrim +
// a keyboard-docked bottom panel), NOT an @expo/ui tree. Built with the app's
// own components so it matches every other screen: the real hollow `CheckCircle`
// radio, the `Input` field, and hairline `bg-divider` rows on the `bg-surface`
// sheet — no muddy filled cards, no @expo/ui layout quirks. There is no "Done"
// button: the circle completes, and Enter / dismissal saves. It does not
// autofocus, so it opens showing a clean sheet; tap the title to edit.
function CaptureDetailSheet({
  open,
  draft,
  onChangeDraft,
  onSubmit,
  onComplete,
  onRefine,
  onOpenSchedule,
  scheduleText,
  scheduled,
  onClose,
}: {
  open: boolean;
  draft: string;
  onChangeDraft: (text: string) => void;
  onSubmit: () => void;
  onComplete: () => void;
  onRefine: () => void;
  onOpenSchedule: () => void;
  scheduleText: string;
  scheduled: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close capture"
        className="flex-1 bg-scrim"
        onPress={onClose}
      />
      <KeyboardStickyView
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
      >
        <View
          accessibilityLabel="sheet"
          style={{ paddingBottom: insets.bottom + 8 }}
          className="rounded-t-2xl bg-surface pt-2 shadow-raised"
        >
          <View className="mb-1 h-1 w-9 self-center rounded-full bg-divider" />

          {/* Identity: the real hollow radio + the editable title, vertically
              centered. The multiline field's default vertical padding is zeroed
              so its text line centers against the 22dp radio. */}
          <View className="flex-row items-center gap-3 px-screen-x py-3">
            <CheckCircle label="Complete capture" onPress={onComplete} />
            <Input
              value={draft}
              onChangeText={onChangeDraft}
              onSubmitEditing={onSubmit}
              returnKeyType="done"
              blurOnSubmit
              multiline
              placeholder="Capture"
              accessibilityLabel="Capture text"
              style={{ paddingTop: 0, paddingBottom: 0 }}
              className="flex-1 text-[18px] font-semibold leading-6"
              testID="capture-edit-input"
            />
          </View>

          <View className="h-px bg-divider" />

          {/* Schedule: one row, opens the selector. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Set schedule"
            onPress={onOpenSchedule}
            testID="capture-schedule"
            className="flex-row items-center gap-3 px-screen-x py-3.5"
          >
            <Text className="w-6 text-center text-[18px]">🗓</Text>
            <Text
              className={
                scheduled
                  ? 'flex-1 text-[16px] font-medium text-accent'
                  : 'flex-1 text-[16px] text-foreground-secondary'
              }
            >
              {scheduleText}
            </Text>
          </Pressable>

          <View className="h-px bg-divider" />

          {/* Refine: the next step. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refine into tasks & projects"
            onPress={onRefine}
            className="flex-row items-center gap-3 px-screen-x py-3.5"
          >
            <Text className="w-6 text-center text-[16px] text-accent">✦</Text>
            <Text className="flex-1 text-[16px] text-accent">
              Refine into tasks &amp; projects
            </Text>
          </Pressable>
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

// The schedule selector: a plain React Native modal (the IconPickerSheet
// pattern), NOT an @expo/ui tree, so it can reproduce Todoist's scheduler — quick
// options with the resolved weekday on the right, an inline month calendar, and a
// "No date" row. It sets a capture's showUpDate (a plain date; no time, no
// recurrence). Rendered at the screen root (above the @expo/ui detail sheet).
function ScheduleSheet({
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
  const today = capturesLocalToday();
  const tmr = tomorrow(today);
  const selected = showUpDate ?? null;

  // The month the grid shows: the selected date's month, else the current month.
  const initial = selected ?? today;
  const [y, m] = initial.split('-').map(Number);
  // Seeded once from the selected date (or today). The call site keys this
  // component by capture id, so it remounts — and reseeds — per capture; the
  // prev/next arrows then drive the visible month from here.
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

// The capture detail editor as one deep module: it owns the detail sheet, the
// schedule selector, and all of their state and writes, behind a small
// interface. Home and Upcoming both open the same editor through this hook
// instead of duplicating ~200 lines of sheet markup.
//
// `list` is the screen's own visible list; the selected capture is resolved as
// `list.find(id)`, so a reschedule that moves a capture out of that list closes
// the sheet (Home drops a future-dated capture; Upcoming drops one pulled to
// today). `handleBack` is returned, not self-registered, so each screen keeps
// its own Back priority (Home must still order quick-add and discard-confirm).
export type CaptureDetail = {
  // Open the editor for a capture (seeds the editable draft from its text).
  open: (item: Capture) => void;
  // Complete a capture with the shared single bottom Undo snackbar. Used by the
  // sheet's check and by each screen's row checks, so the Undo behavior lives in
  // one place.
  process: (item: Capture) => void;
  // The detail sheet + schedule selector, ready to render at the screen root.
  sheets: ReactNode;
  // Consume an Android Back press when a sheet or the scheduler is open. Returns
  // true if it handled the press (the screen should then return true too).
  handleBack: () => boolean;
  // Whether a sheet or the scheduler is currently open.
  active: boolean;
};

export function useCaptureDetail({
  api,
  list,
  onError,
}: {
  api: CapturesApi;
  list: Capture[];
  // Each screen passes its own write-error setter (clears on null).
  onError: (message: string | null) => void;
}): CaptureDetail {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const closingDetailRef = useRef(false);
  const selected = selectedId
    ? (list.find((item) => item.id === selectedId) ?? null)
    : null;

  const open = useCallback((item: Capture) => {
    closingDetailRef.current = false;
    setDraft(item.text);
    setSelectedId(item.id);
  }, []);

  // Every dismissal commits the same trimmed draft before closing. Empty and
  // unchanged drafts preserve the stored text.
  const commitAndClose = useCallback(() => {
    if (closingDetailRef.current) return;
    closingDetailRef.current = true;
    setSelectedId(null);
    const trimmed = draft.trim();
    if (!selected || !trimmed || trimmed === selected.text) return;
    onError(null);
    const tx = api.edit(selected.id, trimmed);
    tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
  }, [api, draft, selected, onError]);

  const process = useCallback(
    (item: Capture) => {
      onError(null);
      // Same single bottom Undo snackbar as task-complete (shared 'undo' id, so
      // only one shows at a time). Undo un-processes the capture back to the inbox.
      undoableAction({
        message: 'Completed',
        act: () => api.process(item.id),
        undo: () => api.unprocess(item),
        onError,
      });
    },
    [api, onError],
  );

  const completeFromSheet = useCallback(() => {
    if (!selected) return;
    const item = selected;
    setSelectedId(null);
    process(item);
  }, [selected, process]);

  const refine = useCallback(() => {
    if (!selected) return;
    startRefine(selected.id, selected.text);
    setSelectedId(null);
  }, [selected]);

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

  const handleBack = useCallback(() => {
    if (scheduling) {
      setScheduling(false);
      return true;
    }
    if (selected) {
      commitAndClose();
      return true;
    }
    return false;
  }, [scheduling, selected, commitAndClose]);

  const sheets = (
    <>
      <CaptureDetailSheet
        open={selected != null}
        draft={draft}
        onChangeDraft={setDraft}
        onSubmit={commitAndClose}
        onClose={commitAndClose}
        onComplete={completeFromSheet}
        onRefine={refine}
        onOpenSchedule={() => setScheduling(true)}
        scheduleText={
          selected ? scheduleLabel(selected.showUpDate, capturesLocalToday()) : ''
        }
        scheduled={selected?.showUpDate != null}
      />

      <ScheduleSheet
        key={selected?.id ?? 'none'}
        open={scheduling && selected != null}
        showUpDate={selected?.showUpDate}
        onPick={onPickSchedule}
        onClose={() => setScheduling(false)}
      />
    </>
  );

  return {
    open,
    process,
    sheets,
    handleBack,
    active: selected != null || scheduling,
  };
}
