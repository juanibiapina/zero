import { UserButton } from '@clerk/expo/native';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  capturesView,
  capturesLocalToday,
  orderKeyBetween,
  tomorrow,
  visibleCaptures,
  type Capture,
  type CapturesApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Pressable,
  StyleSheet,
  TextInput,
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
import { Text } from '@/components/ui/text';
import { useCapturesApi } from '@/lib/use-captures-api';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
// postpone, tap the circle to process, tap the text to edit inline. The swipe is
// a swipe-to-commit (one decisive swipe = the action), so it is a hand-built
// Gesture.Pan, not ReanimatedSwipeable (which is for swipe-to-reveal action
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
  editing,
  editText,
  onProcess,
  onReschedule,
  onEditSubmit,
  onChangeEditText,
  onStartEdit,
}: {
  item: Capture;
  editing: boolean;
  editText: string;
  onProcess: (item: Capture) => void;
  onReschedule: (item: Capture) => void;
  onEditSubmit: (item: Capture) => void;
  onChangeEditText: (text: string) => void;
  onStartEdit: (item: Capture) => void;
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
    .enabled(!editing)
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
          {editing ? (
            <TextInput
              autoFocus
              accessibilityLabel={`Edit "${item.text}"`}
              className="flex-1 text-base text-neutral-900"
              value={editText}
              onChangeText={onChangeEditText}
              onSubmitEditing={() => onEditSubmit(item)}
              onBlur={() => onEditSubmit(item)}
              returnKeyType="done"
            />
          ) : (
            <Pressable
              className="flex-1"
              accessibilityLabel={`Edit "${item.text}"`}
              onPress={() => onStartEdit(item)}
              // Long-press the text body to start a reorder drag (Todoist-style).
              // JS Pressability, so it does not block the list's pan (see note
              // on CaptureRow). delayLongPress matches the platform default.
              onLongPress={() => drag()}
              delayLongPress={500}
            >
              <Text>{item.text}</Text>
            </Pressable>
          )}
          {/* TODO(haptics): Haptics.impactAsync(Light) on commit once
              expo-haptics is added (native module → needs a dev-client rebuild). */}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// How long a list may sit empty-and-loading before it shows the "Loading…"
// text. The local SQLite snapshot hydrates the cached rows in well under this,
// so a normal cold start paints straight to the list with no spinner flash; the
// text only appears on a genuinely slow first load (empty cache waiting on the
// network).
const LOADING_TEXT_DELAY_MS = 1000;

// True only after `active` has held continuously for `ms`. Resets the moment
// `active` goes false, so a fast hydrate never trips it.
function useDelayed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setElapsed(true), ms);
    // Reset in cleanup (not the effect body) so re-entering the active state
    // waits out the delay again, without a synchronous setState on mount.
    return () => {
      clearTimeout(t);
      setElapsed(false);
    };
  }, [active, ms]);
  return active && elapsed;
}

// Read a data layer's load (sync) error from its own channel. Returns the
// message only while an error is the current state.
function useLoadError(api: {
  getLoadError: () => string | null;
  subscribeLoadError: (cb: () => void) => () => void;
}): string | null {
  const [error, setError] = useState<string | null>(() => api.getLoadError());
  useEffect(() => {
    const read = () => setError(api.getLoadError());
    read();
    return api.subscribeLoadError(read);
  }, [api]);
  return error;
}

// Captures is the sole list: unclarified raw thoughts. The quick-add creates a
// Capture; tap a row's circle to Process it.
export default function HomeScreen() {
  const capturesApi = useCapturesApi();

  return (
    <View className="flex-1 px-6 pt-16">
      <View className="mb-4 flex-row items-center justify-between">
        <Text variant="title">Captures</Text>
        {/* No wrapper: a rounded-full/overflow-hidden mask crops the native
            avatar off-center. */}
        <UserButton />
      </View>

      {capturesApi ? <Captures api={capturesApi} /> : <View className="flex-1" />}
    </View>
  );
}

function Captures({ api }: { api: CapturesApi }) {
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
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void api.refetch();
    });
    return () => sub.remove();
  }, [api]);
  // Gate the list on the row count, not isLoading: a hydrated snapshot must
  // paint even while the network sync is still pending, so opening Captures
  // never blinks to a spinner over stale rows.
  const view = capturesView({ count: list.length, isLoading, loadError });
  // Show a load error only when there's nothing on screen, so a failed
  // background refetch stays silent behind the last-good Captures.
  const error = writeError ?? (list.length === 0 ? loadError : null);

  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inputRef = useRef<TextInput>(null);

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
  }, [adding, confirmingDiscard, text, closeAdd]);

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

  // Inline edit: tapping a row's text turns it into a TextInput seeded with the
  // current text; submitting commits (trim, no-op on empty/unchanged).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const onEditSubmit = useCallback(
    (item: Capture) => {
      const trimmed = editText.trim();
      setEditingId(null);
      if (!trimmed || trimmed === item.text) return;
      setWriteError(null);
      const tx = api.edit(item.id, trimmed);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api, editText],
  );

  const onStartEdit = useCallback((item: Capture) => {
    setEditText(item.text);
    setEditingId(item.id);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: Capture }) => (
      <CaptureRow
        item={item}
        editing={editingId === item.id}
        editText={editText}
        onProcess={onProcess}
        onReschedule={onReschedule}
        onEditSubmit={onEditSubmit}
        onChangeEditText={setEditText}
        onStartEdit={onStartEdit}
      />
    ),
    [onProcess, onReschedule, editingId, editText, onEditSubmit, onStartEdit],
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
