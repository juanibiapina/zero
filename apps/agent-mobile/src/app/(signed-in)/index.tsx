import { UserButton } from '@clerk/expo/native';
import { Button, Column, TextInput } from '@expo/ui';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  listView,
  LOADING_TEXT_DELAY_MS,
  capturesLocalToday,
  messageOf,
  orderKeyBetween,
  tomorrow,
  visibleCaptures,
  type Capture,
  type CapturesApi,
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

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { QuickAdd } from '@/components/quick-add';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useCapturesApi } from '@/lib/captures-collection';
import {
  useDelayed,
  useForegroundRefetch,
  useLoadError,
} from '@/lib/screen-hooks';

// Vertical gap between carded rows.
function Separator() {
  return <View className="h-3" />;
}

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
// hand-built Gesture.Pan, not ReanimatedSwipeable (which is for swipe-to-reveal action
// buttons and orphans its action layer when the row is removed). The "Tomorrow"
// background is a child of this wrapper, so it unmounts with the row — no ghost.
//
// Reorder is triggered by a plain RN `Pressable onLongPress={drag}` (JS
// Pressability), NOT a gesture-handler Gesture.LongPress. This is deliberate and
// load-bearing: react-native-reorderable-list tracks the drag with a single pan
// gesture on the whole list, and a competing GH gesture in this row's own
// GestureDetector would block that list pan from activating — the row would lift
// (armed) but never follow the finger. A JS long-press does not participate in
// GH arbitration, so the list pan is free to track. The row's GestureDetector
// therefore carries ONLY the horizontal swipe; horizontal move = swipe, hold =
// drag, vertical move = list scroll/drag. Extracted to its own component so the
// screen's memoized callbacks stay clean.
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
  // Starts the reorderable-list drag for this row; bound to the text's RN
  // `onLongPress` (see the note above — must be a JS long-press, not a GH
  // gesture). Must be called from inside a row rendered by ReorderableList.
  const drag = useReorderableDrag();
  // The card's horizontal offset. 0 at rest (covering the green background);
  // grows rightward as the user swipes, revealing "Tomorrow" underneath.
  const x = useSharedValue(0);
  // Where the card was when this drag started, so a grab mid-animation continues
  // smoothly instead of jumping to 0.
  const startX = useSharedValue(0);

  // Built inline (no useMemo) so the React Compiler owns the memoization; a
  // silent skip of this leaf row is harmless, unlike a manual-memo mismatch.
  const pan = Gesture.Pan()
    // Right-only, and declaring the axis keeps the pan from stealing the list's
    // vertical scroll. A tap has no horizontal travel, so it never activates.
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
        // Snap back.
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
    <View className="overflow-hidden rounded-2xl">
      {/* Revealed as the card slides right. Left-aligned so the label shows in
          the gap the card opens. */}
      <View
        style={StyleSheet.absoluteFill}
        className="flex-row items-center rounded-2xl bg-emerald-600 px-4"
      >
        <Text className="font-medium text-white">Tomorrow</Text>
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={rowStyle}
          className="flex-row items-center gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4"
        >
          <Pressable
            accessibilityLabel={`Process "${item.text}"`}
            className="h-7 w-7 rounded-full border-2 border-neutral-400"
            hitSlop={8}
            onPress={() => onProcess(item)}
          />
          <Pressable
            className="flex-1"
            accessibilityRole="button"
            accessibilityLabel={`Edit "${item.text}"`}
            onPress={() => onOpen(item)}
            // Long-press the text body to start a reorder drag (Todoist-style).
            // JS Pressability, so it does not block the list's pan (see note
            // on CaptureRow). delayLongPress matches the platform default.
            onLongPress={() => drag()}
            delayLongPress={500}
          >
            <Text>{item.text}</Text>
          </Pressable>
          {/* TODO(haptics): Haptics.impactAsync(Light) on commit once
              expo-haptics is added (native module → needs a dev-client rebuild). */}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// Native edit-only sheet body. Keyed by capture id at the call site so the
// uncontrolled native field reseeds when another capture opens.
function CaptureDetail({
  draft,
  onChangeDraft,
  onDone,
}: {
  draft: string;
  onChangeDraft: (text: string) => void;
  onDone: () => void;
}) {
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
          borderRadius: 16,
          backgroundColor: '#f5f5f5',
        }}
        textStyle={{ fontSize: 19, fontWeight: '500', lineHeight: 26 }}
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

// Captures is the sole list: unclarified raw thoughts. The quick-add creates a
// Capture; tap a row's circle to Process it.
export default function HomeScreen() {
  const capturesApi = useCapturesApi();

  // Measure the gap from this screen's content bottom to the window bottom (the
  // native bottom tab bar plus the system gesture inset). The screen is inset
  // above the tab bar, so the keyboard-sticky quick-add over-lifts by this gap;
  // it is fed back as the bar's open offset so it docks to the keyboard. See
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
    <View
      ref={rootRef}
      onLayout={measureBottomGap}
      className="flex-1 px-6 pt-16"
    >
      <View className="mb-4 flex-row items-center justify-between">
        <Text variant="title">Captures</Text>
        {/* No wrapper: a rounded-full/overflow-hidden mask crops the native
            avatar off-center. */}
        <UserButton />
      </View>

      {capturesApi ? (
        <Captures api={capturesApi} bottomOffset={bottomOffset} />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

function Captures({
  api,
  bottomOffset,
}: {
  api: CapturesApi;
  bottomOffset: number;
}) {
  const { data: captures, isLoading } = useLiveQuery((q) =>
    q
      .from({ c: api.collection })
      .where(({ c }) => isNull(c.processedAt))
      .orderBy(({ c }) => c.createdAt, 'asc'),
  );
  // The server returns every open capture (Captures and Upcoming share the same
  // set); this pass keeps only the ones that have shown up, so a just-postponed
  // row leaves the list at once and future-dated rows stay in Upcoming. Overdue
  // rolls in; no red. Memoized so the render-phase filter (and its localToday
  // read) stays out of the React Compiler's path for the screen's callbacks.
  const list = useMemo(
    () => visibleCaptures(captures ?? [], capturesLocalToday()),
    [captures],
  );

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Refresh when the app returns to the foreground, so a list changed elsewhere
  // (Telegram, another device) shows up without a cold start.
  useForegroundRefetch(api.refetch);
  // Gate the list on the row count, not isLoading: a hydrated snapshot must
  // paint even while the network sync is still pending, so opening Captures
  // never blinks to a spinner over stale rows.
  const view = listView({ count: list.length, isLoading, loadError });
  // Show a load error only when there's nothing on screen, so a failed
  // background refetch stays silent behind the last-good Captures.
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
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    // Keep the bar open and cleared for rapid, repeated capture.
    setText('');
  }, [text, api]);

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

  // First Android Back press with the keyboard up is swallowed by the OS to
  // hide the keyboard and never reaches BackHandler. So treat "keyboard hidden
  // while the quick-add is open" as a dismiss request, giving the Todoist
  // single-back behavior: with unsaved text, confirm before discarding; with an
  // empty input, close the bar (previously it stayed open, needing a second
  // Back). Guard on `adding` (not confirming) so the hide that fires while
  // closing (input unmounts) doesn't re-trigger.
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
  // is already down (dialog open, or bar open after the keyboard was hidden).
  // Returning true consumes the event so the OS does not navigate away.
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
  // an end) bound the new key. Optimistic setSortKey + the re-sort land it in
  // place; surface a write error like the other verbs.
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

  // Only surface the loading text once the snapshot has had time to hydrate;
  // otherwise a cached cold start would flash it for the sub-second the rows
  // take to arrive.
  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);

  return (
    <>
      {error ? <Text variant="error">{error}</Text> : null}

      {view === 'loading' ? (
        showLoadingText ? (
          <Text variant="subtitle">Loading your captures…</Text>
        ) : (
          <View className="flex-1" />
        )
      ) : (
        // ReorderableList extends FlatList (so it still virtualizes the
        // unbounded Captures list) and adds long-press drag-to-reorder with its
        // own drop indicator and autoscroll. itemLayoutAnimation slides the
        // remaining rows closed when one is processed or postponed; onReorder
        // fires once on drop with the from/to indices.
        <ReorderableList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 96 }}
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          itemLayoutAnimation={LinearTransition.duration(200)}
          onReorder={onReorder}
          ListEmptyComponent={
            <Text variant="subtitle">
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
          lifts the bar with the keyboard. It owns the motion; this screen owns
          the state. */}
      <QuickAdd
        open={adding}
        text={text}
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
            // The Back that opened this dialog also hid the keyboard; refocus to
            // bring it back so editing continues seamlessly.
            inputRef.current?.focus();
          }}
          onConfirm={closeAdd}
        />
      ) : null}
    </>
  );
}
