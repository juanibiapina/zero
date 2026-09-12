import { Button, Host } from '@expo/ui';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  listView,
  LOADING_TEXT_DELAY_MS,
  homeCallToAction,
  homeCallToActionCopy,
  homeTasks,
  DEFAULT_ICON,
  localToday,
  messageOf,
  orderKeyBetween,
  taskIcon,
  toast,
  tomorrow,
  undoableAction,
  type AddMode,
  type HomeCallToAction,
  type ProjectsApi,
  type Task,
  type TasksApi,
  type WaitsApi,
} from '@zero/agent-core';
import { useAuth } from '@clerk/expo';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  RefreshControl,
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
import { useTaskDetail } from '@/components/task-detail';
import { CheckCircle } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { requestIconSuggestions } from '@/lib/icon-suggestions';
import { useTasksApi } from '@/lib/tasks-collection';
import { useProjectsApi } from '@/lib/projects-collection';
import { useWaitsApi } from '@/lib/waits-collection';
import { useColor } from '@/lib/theme';
import {
  useDelayed,
  useForegroundRefetch,
  useLoadError,
  usePullRefresh,
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

// One task row in the single Home list: long-press the text to drag-reorder,
// swipe right to postpone (to tomorrow), tap the circle to complete, tap the
// text to open its detail sheet. A project task also shows its project's icon
// badge. The swipe is a swipe-to-commit (one decisive swipe =
// the action), so it is a hand-built Gesture.Pan, not ReanimatedSwipeable. The
// row is flat (Todoist style): the sliding card is opaque so it covers the
// "Tomorrow" reveal beneath it, and a hairline divider sits under the row and
// does not move with the swipe. Animated.View is not an RN core component, so
// Uniwind does not map `className` onto it — its static styling comes from a
// resolved class list.
//
// Reorder is triggered by a plain RN `Pressable onLongPress={drag}` (JS
// Pressability), NOT a gesture-handler Gesture.LongPress. This is deliberate and
// load-bearing: react-native-reorderable-list tracks the drag with a single pan
// gesture on the whole list, and a competing GH gesture in this row's own
// GestureDetector would block that list pan from activating. A JS long-press
// does not participate in GH arbitration, so the list pan is free to track. The
// row's GestureDetector therefore carries ONLY the horizontal swipe. Ported from
// the former CaptureRow in the single-list merge.
function TaskRow({
  item,
  icon,
  onComplete,
  onReschedule,
  onOpen,
}: {
  item: Task;
  // The task's project icon, or null for a loose task (shows no badge).
  icon: string | null;
  onComplete: (item: Task) => void;
  onReschedule: (item: Task) => void;
  onOpen: (item: Task) => void;
}) {
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const drag = useReorderableDrag();
  const x = useSharedValue(0);
  const startX = useSharedValue(0);

  const cardStyle = useResolveClassNames(
    'flex-row items-center gap-3 bg-background px-screen-x py-row-y',
  );

  const pan = Gesture.Pan()
    .activeOffsetX(12)
    .failOffsetY([-6, 6])
    .onStart(() => {
      startX.set(x.get());
    })
    .onUpdate((e) => {
      x.set(Math.max(0, startX.get() + e.translationX));
    })
    .onEnd((e) => {
      const projected = x.get() + project(e.velocityX);
      if (projected > SWIPE_THRESHOLD) {
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
    <View className="bg-background">
      <View className="overflow-hidden bg-background">
        <View
          style={StyleSheet.absoluteFill}
          className="flex-row items-center bg-swipe-postpone px-screen-x"
        >
          <Text className="font-medium text-on-accent">Tomorrow</Text>
        </View>
        <GestureDetector gesture={pan}>
          <Animated.View style={[cardStyle, rowStyle]}>
            <CheckCircle
              label={`Complete "${item.text}"`}
              onPress={() => onComplete(item)}
            />
            {icon != null ? <Text className="text-[16px]">{icon}</Text> : null}
            <Pressable
              className="flex-1"
              accessibilityRole="button"
              accessibilityLabel={`Edit "${item.text}"`}
              onPress={() => onOpen(item)}
              onLongPress={() => drag()}
              delayLongPress={500}
            >
              <Text>{item.text}</Text>
            </Pressable>
          </Animated.View>
        </GestureDetector>
      </View>
      <View className="ml-[50px] h-px bg-divider" />
    </View>
  );
}

// The all-clear state on Home: shown only when the list is empty. The shared
// homeCallToAction seam picks the framing from the projects' derived states;
// every case routes to the Projects tab.
function HomeCallToActionView({ action }: { action: HomeCallToAction }) {
  const { title, body, button } = homeCallToActionCopy(action);
  return (
    <View className="flex-1 items-center justify-center gap-4 px-screen-x">
      <View className="items-center gap-1">
        <Text variant="title" className="text-center">
          {title}
        </Text>
        {body ? (
          <Text variant="subtitle" className="text-center">
            {body}
          </Text>
        ) : null}
      </View>
      <Host matchContents>
        <Button
          label={button}
          variant="filled"
          style={{ height: 48, borderRadius: 14, paddingHorizontal: 20 }}
          onPress={() => router.navigate('/projects')}
        />
      </Host>
    </View>
  );
}

// Home is one reorderable list of tasks: the loose ones you dropped in and the
// project tasks you have taken on (availability-gated by homeTasks). No separate
// capture inbox after the single-list merge. The quick-add defaults to a task
// and can switch to a project.
export default function HomeScreen() {
  const tasksApi = useTasksApi();
  const projectsApi = useProjectsApi();
  const waitsApi = useWaitsApi();

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
      {tasksApi && projectsApi && waitsApi ? (
        <Home
          api={tasksApi}
          projectsApi={projectsApi}
          waitsApi={waitsApi}
          bottomOffset={bottomOffset}
        />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

function Home({
  api,
  projectsApi,
  waitsApi,
  bottomOffset,
}: {
  api: TasksApi;
  projectsApi: ProjectsApi;
  waitsApi: WaitsApi;
  bottomOffset: number;
}) {
  const [mode, setMode] = useState<AddMode>('task');
  // The reorderable list's reorder pan must wait for a long-press before it
  // activates, or on Android it fights the RefreshControl's SwipeRefreshLayout
  // and blocks list scrolling and pull-to-refresh (per the library's
  // RefreshControl example). 520ms is just above the row's 500ms long-press.
  const reorderPanGesture = useMemo(
    () => Gesture.Pan().activateAfterLongPress(520),
    [],
  );
  const { getToken } = useAuth();
  const { data: tasks, isLoading } = useLiveQuery((q) =>
    q.from({ t: api.collection }).where(({ t }) => isNull(t.completedAt)),
  );
  const { data: projects, isLoading: projectsLoading } = useLiveQuery((q) =>
    q.from({ p: projectsApi.collection }),
  );
  const { data: conditions } = useLiveQuery((q) =>
    q.from({ w: waitsApi.collection }),
  );

  const today = localToday();
  // The single Home list: open ∧ shown-up ∧ available, ordered by the manual
  // sort key. The server returns all open tasks; this pass drops future-dated
  // ones (they belong to Upcoming) and unavailable project tasks.
  const list = useMemo(
    () => homeTasks(tasks ?? [], projects ?? [], today, conditions ?? []),
    [tasks, projects, conditions, today],
  );

  const cta = homeCallToAction(
    list.length,
    0,
    projects ?? [],
    tasks ?? [],
    today,
    conditions ?? [],
  );
  // Do not flash the CTA while the local snapshot hydrates (every collection
  // reads empty then, which would look like "create").
  const hydrating = isLoading || projectsLoading;

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  useForegroundRefetch(api.refetch);

  const accent = useColor('--color-accent');
  const refetchAll = useCallback(
    () =>
      Promise.all([api.refetch(), projectsApi.refetch(), waitsApi.refetch()]),
    [api, projectsApi, waitsApi],
  );
  const { refreshing, onRefresh } = usePullRefresh(refetchAll);
  const [refreshEnabled, setRefreshEnabled] = useState(true);
  const onDragStart = useCallback(() => {
    'worklet';
    if (Platform.OS === 'android' && !refreshing) {
      scheduleOnRN(setRefreshEnabled, false);
    }
  }, [refreshing]);
  const onDragEnd = useCallback(() => {
    'worklet';
    if (Platform.OS === 'android') {
      scheduleOnRN(setRefreshEnabled, true);
    }
  }, []);
  const view = listView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);

  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inputRef = useRef<RNTextInput>(null);

  // The task detail editor (sheet + schedule selector + their writes). It
  // resolves the selected task from Home's visible `list`, so rescheduling a
  // task to a future day drops it from the list and closes the sheet.
  const detail = useTaskDetail({
    api,
    list,
    projects: projects ?? [],
    onError: setWriteError,
  });

  // A project task's icon (defaulting to the neutral one); a loose task has none.
  // The rule lives in the shared taskIcon resolver, so Home and Upcoming agree.
  const iconOf = useCallback(
    (item: Task): string | null => taskIcon(item, projects ?? []),
    [projects],
  );

  const closeAdd = useCallback(() => {
    setText('');
    setConfirmingDiscard(false);
    setAdding(false);
  }, []);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    setWriteError(null);
    if (mode === 'project') {
      // Create the project but stay on Home; a toast is the escape hatch to jump
      // to it. The id comes off the optimistic insert transaction so the toast
      // can deep-link before the server round-trip finishes.
      const tx = projectsApi.add(trimmed);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
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
    // A quick-add with no project creates a loose open task on Home (no day).
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    closeAdd();
  }, [text, api, projectsApi, mode, getToken, closeAdd]);

  const requestClose = useCallback(() => {
    if (text.trim()) {
      setConfirmingDiscard(true);
    } else {
      closeAdd();
    }
  }, [text, closeAdd]);

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

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail.handleBack()) {
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
  }, [detail, adding, confirmingDiscard, text, closeAdd]);

  // Postpone to tomorrow (the swipe-right action). The optimistic reschedule
  // drops the row from Home at once and lands it in Upcoming.
  const onReschedule = useCallback(
    (item: Task) => {
      setWriteError(null);
      const tx = api.reschedule(item.id, tomorrow(today));
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api, today],
  );

  // Complete: commit immediately (the row leaves at once) + a single bottom Undo
  // snackbar (shared 'undo' id). A project task also names its project and offers
  // an Open deep-link; a loose task shows neither. Undo reopens the task.
  const onComplete = useCallback(
    (item: Task) => {
      const project =
        item.projectId != null
          ? (projects ?? []).find((p) => p.id === item.projectId)
          : undefined;
      undoableAction({
        message: 'Completed',
        description: project
          ? `${project.icon ?? DEFAULT_ICON} ${project.title}`
          : undefined,
        link: project
          ? {
              label: 'Open',
              onPress: () =>
                router.navigate(`/projects/${project.id}`, { withAnchor: true }),
            }
          : undefined,
        act: () => api.complete(item.id),
        undo: () => api.reopen(item),
        onError: setWriteError,
      });
    },
    [api, projects],
  );

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
    ({ item }: { item: Task }) => (
      <TaskRow
        item={item}
        icon={iconOf(item)}
        onComplete={onComplete}
        onReschedule={onReschedule}
        onOpen={detail.open}
      />
    ),
    [iconOf, onComplete, onReschedule, detail.open],
  );

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
            Loading your tasks…
          </Text>
        ) : (
          <View className="flex-1" />
        )
      ) : view === 'empty' && cta && !loadError ? (
        hydrating ? (
          <View className="flex-1" />
        ) : (
          <HomeCallToActionView action={cta} />
        )
      ) : (
        <ReorderableList
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 96 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              enabled={refreshEnabled}
              tintColor={accent}
              colors={[accent]}
            />
          }
          data={list}
          keyExtractor={(item) => item.id}
          panGesture={reorderPanGesture}
          renderItem={renderItem}
          itemLayoutAnimation={LinearTransition.duration(200)}
          onReorder={onReorder}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      )}

      {detail.sheets}

      <QuickAdd
        open={adding}
        text={text}
        mode={mode}
        onModeChange={setMode}
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
            inputRef.current?.focus();
          }}
          onConfirm={closeAdd}
        />
      ) : null}
    </>
  );
}
