import { Button, Column, TextInput } from '@expo/ui';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  listView,
  LOADING_TEXT_DELAY_MS,
  capturesLocalToday,
  homeTasks,
  localToday,
  messageOf,
  orderKeyBetween,
  tomorrow,
  visibleCaptures,
  type Capture,
  type CapturesApi,
  type Task,
  type TasksApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  StyleSheet,
  type TextInput as RNTextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardEvents } from 'react-native-keyboard-controller';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReorderableList, {
  reorderItems,
  useReorderableDrag,
  type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';
import Animated, {
  Easing,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useResolveClassNames } from 'uniwind';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { QuickAdd } from '@/components/quick-add';
import { ScreenHeader } from '@/components/screen-header';
import { CheckCircle, ListRow } from '@/components/ui/list-row';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useCapturesApi } from '@/lib/captures-collection';
import { useTasksApi } from '@/lib/tasks-collection';
import { useColor } from '@/lib/theme';
import {
  useDelayed,
  useForegroundRefetch,
  useLoadError,
} from '@/lib/screen-hooks';

// Strong ease-out for the commit slide (from the Expo animation recipe).
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
// A right-swipe commits once the projected resting position passes this many
// px, so a short fast flick commits and a slow long drag does not.
const SWIPE_THRESHOLD = 140;

// Where the finger would come to rest if it kept decelerating (Apple's
// exponential-decay form). Lets a flick commit on velocity, not just distance.
function project(velocity: number, decelerationRate = 0.998): number {
  'worklet';
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

// One Captures row: long-press the text to drag-reorder, swipe right to
// postpone, tap the circle to process, tap the text to open its detail sheet.
// The swipe is a swipe-to-commit (one decisive swipe = the action), so it is a
// hand-built Gesture.Pan, not ReanimatedSwipeable. The row is flat (Todoist
// style): the sliding card is opaque so it covers the "Tomorrow" reveal beneath
// it, and a hairline divider sits under the row and does not move with the
// swipe. Animated.View is not an RN core component, so Uniwind does not map
// `className` onto it — its static styling comes from a resolved class list.
//
// Reorder is triggered by a plain RN `Pressable onLongPress={drag}` (JS
// Pressability), NOT a gesture-handler Gesture.LongPress. This is deliberate and
// load-bearing: react-native-reorderable-list tracks the drag with a single pan
// gesture on the whole list, and a competing GH gesture in this row's own
// GestureDetector would block that list pan from activating. A JS long-press
// does not participate in GH arbitration, so the list pan is free to track. The
// row's GestureDetector therefore carries ONLY the horizontal swipe.
function CaptureRow({
  item,
  onProcess,
  onReschedule,
  onOpen,
}: {
  item: Capture;
  onProcess: (item: Capture) => void;
  onReschedule: (item: Capture) => void;
  onOpen: (item: Capture) => void;
}) {
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const drag = useReorderableDrag();
  // The card's horizontal offset. 0 at rest (covering the reveal); grows
  // rightward as the user swipes, revealing "Tomorrow" underneath.
  const x = useSharedValue(0);
  // Where the card was when this drag started, so a grab mid-animation continues
  // smoothly instead of jumping to 0.
  const startX = useSharedValue(0);

  // Opaque flat card styling. Resolved from classes because Animated.View is not
  // Uniwind-mapped; combined with the animated transform below.
  const cardStyle = useResolveClassNames(
    'flex-row items-center gap-3 bg-background px-screen-x py-row-y',
  );

  // Built inline (no useMemo) so the React Compiler owns the memoization; a
  // silent skip of this leaf row is harmless.
  const pan = Gesture.Pan()
    .activeOffsetX(12)
    .onStart(() => {
      startX.set(x.get());
    })
    .onUpdate((e) => {
      x.set(Math.max(0, startX.get() + e.translationX));
    })
    .onEnd((e) => {
      const projected = x.get() + project(e.velocityX);
      if (projected > SWIPE_THRESHOLD) {
        // Commit: slide the card fully off, then remove it. The optimistic hide
        // drops the row and the list's itemLayoutAnimation closes the gap.
        x.set(
          withTiming(
            width,
            { duration: 200, easing: EASE_OUT, reduceMotion: ReduceMotion.System },
            (finished) => {
              if (finished) scheduleOnRN(onReschedule, item);
            },
          ),
        );
      } else {
        x.set(
          withSpring(0, {
            duration: 300,
            dampingRatio: 1,
            velocity: e.velocityX,
            reduceMotion: ReduceMotion.System,
          }),
        );
      }
    });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: reduced ? 0 : x.get() }],
  }));

  return (
    <View className="overflow-hidden bg-background">
      {/* Revealed as the card slides right. Left-aligned so the label shows in
          the gap the card opens. */}
      <View
        style={StyleSheet.absoluteFill}
        className="flex-row items-center bg-swipe-postpone px-screen-x"
      >
        <Text className="font-medium text-on-accent">Tomorrow</Text>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[cardStyle, rowStyle]}>
          <CheckCircle
            label={`Process "${item.text}"`}
            onPress={() => onProcess(item)}
          />
          <Pressable
            className="flex-1"
            accessibilityRole="button"
            accessibilityLabel={`Edit "${item.text}"`}
            onPress={() => onOpen(item)}
            // Long-press the text body to start a reorder drag (Todoist-style).
            // JS Pressability, so it does not block the list's pan.
            onLongPress={() => drag()}
            delayLongPress={500}
          >
            <Text>{item.text}</Text>
          </Pressable>
        </Animated.View>
      </GestureDetector>
      {/* Divider sits below the row and does not move with the swipe. */}
      <View className="ml-[50px] h-px bg-divider" />
    </View>
  );
}

// Native edit-only sheet body. Keyed by capture id at the call site so the
// uncontrolled native field reseeds when another capture opens. Colors come from
// tokens via useColor (@expo/ui takes string colors, not classes).
function CaptureDetail({
  draft,
  onChangeDraft,
  onDone,
}: {
  draft: string;
  onChangeDraft: (text: string) => void;
  onDone: () => void;
}) {
  const surfaceMuted = useColor('--color-surface-muted');
  const foreground = useColor('--color-foreground');
  return (
    <Column spacing={20}>
      <TextInput
        autoFocus
        defaultValue={draft}
        onChangeText={onChangeDraft}
        onSubmitEditing={onDone}
        returnKeyType="done"
        placeholder="Capture"
        style={{
          height: 72,
          paddingHorizontal: 18,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: surfaceMuted,
        }}
        textStyle={{ fontSize: 18, fontWeight: '500', lineHeight: 24, color: foreground }}
        testID="capture-edit-input"
      />
      <Button
        label="Done"
        variant="filled"
        style={{ height: 48, borderRadius: 14 }}
        onPress={onDone}
      />
    </Column>
  );
}

// One task row in the Home top region: a complete circle and the text. The
// availability rule (which tasks show) lives in the shared homeTasks seam.
function TaskRow({
  item,
  onComplete,
}: {
  item: Task;
  onComplete: (item: Task) => void;
}) {
  return (
    <ListRow
      leading={
        <CheckCircle
          label={`Complete "${item.text}"`}
          onPress={() => onComplete(item)}
        />
      }
    >
      <Text>{item.text}</Text>
    </ListRow>
  );
}

// The Home top region: the tasks you have taken on, rendered above the capture
// inbox as the list header. Slice 1 shows every open task; later slices gate it
// by project and selection through homeTasks.
function TasksTop({
  api,
  onError,
}: {
  api: TasksApi;
  onError: (message: string) => void;
}) {
  const { data: tasks } = useLiveQuery((q) =>
    q
      .from({ t: api.collection })
      .where(({ t }) => isNull(t.completedAt))
      .orderBy(({ t }) => t.createdAt, 'asc'),
  );
  useForegroundRefetch(api.refetch);
  const list = useMemo(() => homeTasks(tasks ?? []), [tasks]);
  const onComplete = useCallback(
    (item: Task) => {
      const tx = api.complete(item.id);
      tx.isPersisted.promise.catch((e) => onError(messageOf(e)));
    },
    [api, onError],
  );
  return (
    <View>
      <Text variant="caption" className="px-screen-x pb-1 pt-2">
        Today
      </Text>
      {list.length === 0 ? (
        <Text variant="subtitle" className="px-screen-x pb-2">
          No tasks yet. Add one to work on today.
        </Text>
      ) : (
        list.map((item) => (
          <TaskRow key={item.id} item={item} onComplete={onComplete} />
        ))
      )}
      <Text variant="caption" className="px-screen-x pb-1 pt-3">
        Inbox
      </Text>
    </View>
  );
}

// Home is two regions: the tasks you have taken on (TasksTop) above the capture
// inbox. The quick-add defaults to a capture and can switch to a task.
export default function HomeScreen() {
  const capturesApi = useCapturesApi();
  const tasksApi = useTasksApi();

  // Measure the gap from this screen's content bottom to the window bottom (the
  // native bottom tab bar plus the system gesture inset), fed to the
  // keyboard-sticky quick-add so it docks to the keyboard. See
  // QuickAdd.bottomOffset.
  const { height: windowHeight } = useWindowDimensions();
  const rootRef = useRef<View>(null);
  const [bottomOffset, setBottomOffset] = useState(0);
  const measureBottomGap = useCallback(() => {
    rootRef.current?.measureInWindow((_x, y, _w, h) => {
      setBottomOffset(Math.max(0, windowHeight - (y + h)));
    });
  }, [windowHeight]);

  return (
    <View ref={rootRef} onLayout={measureBottomGap} className="flex-1 bg-background">
      <ScreenHeader title="Home" />
      {capturesApi && tasksApi ? (
        <Captures
          api={capturesApi}
          tasksApi={tasksApi}
          bottomOffset={bottomOffset}
        />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

type AddMode = 'capture' | 'task';

function Captures({
  api,
  tasksApi,
  bottomOffset,
}: {
  api: CapturesApi;
  tasksApi: TasksApi;
  bottomOffset: number;
}) {
  const [mode, setMode] = useState<AddMode>('capture');
  const { data: captures, isLoading } = useLiveQuery((q) =>
    q
      .from({ c: api.collection })
      .where(({ c }) => isNull(c.processedAt))
      .orderBy(({ c }) => c.createdAt, 'asc'),
  );
  // The server returns every open capture (Captures and Upcoming share the same
  // set); this pass keeps only the ones that have shown up, so a just-postponed
  // row leaves the list at once and future-dated rows stay in Upcoming.
  const list = useMemo(
    () => visibleCaptures(captures ?? [], capturesLocalToday()),
    [captures],
  );

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Refresh when the app returns to the foreground.
  useForegroundRefetch(api.refetch);
  // Gate the list on the row count, not isLoading: a hydrated snapshot must
  // paint even while the network sync is still pending.
  const view = listView({ count: list.length, isLoading, loadError });
  // Show a load error only when there's nothing on screen.
  const error = writeError ?? (list.length === 0 ? loadError : null);

  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inputRef = useRef<RNTextInput>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const closingDetailRef = useRef(false);
  const selected = selectedId
    ? (list.find((item) => item.id === selectedId) ?? null)
    : null;

  const openDetail = useCallback((item: Capture) => {
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
    setWriteError(null);
    const tx = api.edit(selected.id, trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
  }, [api, draft, selected]);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Submitting an empty input closes the quick-add bar.
      setAdding(false);
      return;
    }
    setWriteError(null);
    // Optimistic: the row appears at once; surface a failure if the write loses.
    // The mode decides where it lands: a task dated today, or a capture.
    const tx =
      mode === 'task' ? tasksApi.add(trimmed, localToday()) : api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    // Keep the bar open and cleared for rapid, repeated entry.
    setText('');
  }, [text, api, tasksApi, mode]);

  const closeAdd = useCallback(() => {
    setText('');
    setConfirmingDiscard(false);
    setAdding(false);
  }, []);

  // Dismissing the quick-add: with unsaved text, confirm before discarding;
  // with an empty input, close silently.
  const requestClose = useCallback(() => {
    if (text.trim()) {
      setConfirmingDiscard(true);
    } else {
      closeAdd();
    }
  }, [text, closeAdd]);

  // First Android Back press with the keyboard up is swallowed by the OS to hide
  // the keyboard and never reaches BackHandler. So treat "keyboard hidden while
  // the quick-add is open" as a dismiss request (the Todoist single-back
  // behavior). Guard on `adding` (not confirming) so the hide that fires while
  // closing doesn't re-trigger.
  useEffect(() => {
    const sub = KeyboardEvents.addListener('keyboardDidHide', () => {
      if (!adding || confirmingDiscard) return;
      if (text.trim()) {
        setConfirmingDiscard(true);
      } else {
        closeAdd();
      }
    });
    return () => sub.remove();
  }, [adding, confirmingDiscard, text, closeAdd]);

  // Android hardware / navigation back button, for the cases where the keyboard
  // is already down. Returning true consumes the event.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selected) {
        commitAndClose();
        return true;
      }
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
    });
    return () => sub.remove();
  }, [selected, commitAndClose, adding, confirmingDiscard, text, closeAdd]);

  const onProcess = useCallback(
    (item: Capture) => {
      setWriteError(null);
      const tx = api.process(item.id);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
  );

  const onReschedule = useCallback(
    (item: Capture) => {
      setWriteError(null);
      const tx = api.reschedule(item.id, tomorrow(capturesLocalToday()));
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
  );

  // Drop: mint a key strictly between the moved row's new neighbors and persist
  // it. reorderItems gives the post-drop order; the neighbors' keys (or null at
  // an end) bound the new key.
  const onReorder = useCallback(
    ({ from, to }: ReorderableListReorderEvent) => {
      if (from === to) return;
      const moved = reorderItems(list, from, to);
      const item = moved[to];
      if (!item) return;
      const prev = moved[to - 1]?.sortKey ?? null;
      const next = moved[to + 1]?.sortKey ?? null;
      setWriteError(null);
      const tx = api.reorder(item.id, orderKeyBetween(prev, next));
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api, list],
  );

  const renderItem = useCallback(
    ({ item }: { item: Capture }) => (
      <CaptureRow
        item={item}
        onProcess={onProcess}
        onReschedule={onReschedule}
        onOpen={openDetail}
      />
    ),
    [onProcess, onReschedule, openDetail],
  );

  // Only surface the loading text once the snapshot has had time to hydrate.
  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);

  return (
    <>
      {error ? (
        <Text variant="error" className="px-screen-x">
          {error}
        </Text>
      ) : null}

      {view === 'loading' ? (
        showLoadingText ? (
          <Text variant="subtitle" className="px-screen-x">
            Loading your captures…
          </Text>
        ) : (
          <View className="flex-1" />
        )
      ) : (
        // ReorderableList extends FlatList (so it still virtualizes the unbounded
        // Captures list) and adds long-press drag-to-reorder. itemLayoutAnimation
        // slides the remaining rows closed when one is processed or postponed.
        <ReorderableList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 96 }}
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          itemLayoutAnimation={LinearTransition.duration(200)}
          onReorder={onReorder}
          ListHeaderComponent={
            <TasksTop api={tasksApi} onError={setWriteError} />
          }
          ListEmptyComponent={
            <Text variant="subtitle" className="px-screen-x">
              No captures yet. Capture something.
            </Text>
          }
        />
      )}

      <Sheet open={selected != null} onClose={commitAndClose}>
        {selected ? (
          <CaptureDetail
            key={selected.id}
            draft={draft}
            onChangeDraft={setDraft}
            onDone={commitAndClose}
          />
        ) : null}
      </Sheet>

      {/* Transition layer: cross-fades the plus FAB and the quick-add bar and
          lifts the bar with the keyboard. */}
      <QuickAdd
        open={adding}
        text={text}
        mode={mode}
        onModeChange={setMode}
        placeholder={mode === 'task' ? 'Add a task' : 'Capture a thought'}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={() => onAdd()}
        onRequestClose={requestClose}
        busy={false}
        inputRef={inputRef}
        bottomOffset={bottomOffset}
      />

      {confirmingDiscard ? (
        <ConfirmDialog
          title="Discard changes?"
          message="The changes you've made will not be saved."
          cancelLabel="Cancel"
          confirmLabel="Discard"
          destructive
          onCancel={() => {
            setConfirmingDiscard(false);
            // The Back that opened this dialog also hid the keyboard; refocus.
            inputRef.current?.focus();
          }}
          onConfirm={closeAdd}
        />
      ) : null}
    </>
  );
}
