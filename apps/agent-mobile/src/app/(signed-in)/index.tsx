import { useAuth } from '@clerk/expo';
import { UserButton } from '@clerk/expo/native';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useQueryClient } from '@tanstack/react-query';
import {
  dueToday,
  inboxView,
  localToday,
  todayView,
  type Capture,
  type CapturesApi,
  type Task,
  type TasksApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  type ListRenderItemInfo,
  Pressable,
  type TextInput,
  View,
} from 'react-native';
import { KeyboardEvents } from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
} from 'react-native-reanimated';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { QuickAdd } from '@/components/quick-add';
import { Text } from '@/components/ui/text';
import { createMobileCapturesApi } from '@/lib/captures-collection';
import { createMobileTasksApi } from '@/lib/tasks-collection';
import { cn } from '@/lib/cn';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const AnimatedCaptureList = Animated.FlatList<Capture>;
const AnimatedTaskList = Animated.FlatList<Task>;

// Vertical gap between carded rows.
function Separator() {
  return <View className="h-3" />;
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

// Build the Capture data layer once inside the signed-in tree, where the Clerk
// token getter is valid. getToken is read through a ref so the collection is
// built once (not rebuilt when Clerk hands back a new function identity).
function useCapturesApi(): CapturesApi | null {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const [api, setApi] = useState<CapturesApi | null>(null);
  useEffect(() => {
    let live = true;
    let built: CapturesApi | null = null;
    void createMobileCapturesApi({
      queryClient,
      getToken: () => getTokenRef.current(),
    }).then((a) => {
      built = a;
      if (live) {
        setApi(a);
      } else {
        // Unmounted before it resolved: release the collection's subscription.
        void a.collection.cleanup();
      }
    });
    return () => {
      live = false;
      if (built) void built.collection.cleanup();
    };
  }, [queryClient]);

  return api;
}

// Sibling of useCapturesApi for the Task (Today) data layer. Built once in the
// signed-in tree with its own separate SQLite files. Kept structurally
// identical to the Capture hook until a shared base is extracted at entity #3.
function useTasksApi(): TasksApi | null {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const [api, setApi] = useState<TasksApi | null>(null);
  useEffect(() => {
    let live = true;
    let built: TasksApi | null = null;
    void createMobileTasksApi({
      queryClient,
      getToken: () => getTokenRef.current(),
    }).then((a) => {
      built = a;
      if (live) {
        setApi(a);
      } else {
        void a.collection.cleanup();
      }
    });
    return () => {
      live = false;
      if (built) void built.collection.cleanup();
    };
  }, [queryClient]);

  return api;
}

// Read a data layer's load (sync) error from its own channel. Returns the
// message only while an error is the current state. Works for both the Capture
// and Task apis (same getLoadError/subscribeLoadError shape).
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

type Tab = 'inbox' | 'today';

// Inbox holds unclarified Captures; Today holds Tasks due on or before today.
// The active tab is also the entry target: the quick-add creates a Capture on
// Inbox and a Task dated today on Today.
export default function HomeScreen() {
  const capturesApi = useCapturesApi();
  const tasksApi = useTasksApi();
  const [tab, setTab] = useState<Tab>('inbox');

  return (
    <View className="flex-1 px-6 pt-16">
      <View className="mb-4 flex-row items-center justify-between">
        <Text variant="title">{tab === 'inbox' ? 'Inbox' : 'Today'}</Text>
        {/* No wrapper: a rounded-full/overflow-hidden mask crops the native
            avatar off-center. */}
        <UserButton />
      </View>

      <SegmentedControl tab={tab} onChange={setTab} />

      {/* Both panels stay mounted so switching tabs is instant and neither list
          re-hydrates; the inactive one is hidden (display:none takes no space,
          its quick-add overlay hides with it) but its live query stays warm. */}
      <View
        className="flex-1"
        style={tab === 'inbox' ? undefined : { display: 'none' }}
      >
        {capturesApi ? <Inbox api={capturesApi} /> : <View className="flex-1" />}
      </View>
      <View
        className="flex-1"
        style={tab === 'today' ? undefined : { display: 'none' }}
      >
        {tasksApi ? <Today api={tasksApi} /> : <View className="flex-1" />}
      </View>
    </View>
  );
}

function SegmentedControl({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
}) {
  const item = (value: Tab, label: string) => {
    const active = tab === value;
    return (
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        className={cn(
          'flex-1 items-center rounded-lg py-1.5',
          active && 'bg-white shadow-sm',
        )}
        onPress={() => onChange(value)}
      >
        <Text className={cn(active ? 'text-neutral-900' : 'text-neutral-500')}>
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <View className="mb-4 flex-row gap-1 rounded-xl bg-neutral-100 p-1">
      {item('inbox', 'Inbox')}
      {item('today', 'Today')}
    </View>
  );
}

function Inbox({ api }: { api: CapturesApi }) {
  const { data: captures, isLoading } = useLiveQuery((q) =>
    q
      .from({ c: api.collection })
      .where(({ c }) => isNull(c.processedAt))
      .orderBy(({ c }) => c.createdAt, 'asc'),
  );
  const list = captures ?? [];

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
  // paint even while the network sync is still pending, so opening the Inbox
  // never blinks to a spinner over stale rows.
  const view = inboxView({ count: list.length, isLoading, loadError });
  // Show a load error only when there's nothing on screen, so a failed
  // background refetch stays silent behind the last-good Inbox.
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

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Capture>) => (
      <Animated.View
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(200)}
        className="flex-row items-center gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4"
      >
        <Pressable
          accessibilityLabel={`Process "${item.text}"`}
          className="h-7 w-7 rounded-full border-2 border-neutral-400"
          hitSlop={8}
          onPress={() => onProcess(item)}
        />
        <Text className="flex-1">{item.text}</Text>
      </Animated.View>
    ),
    [onProcess],
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
          <Text variant="subtitle">Loading your inbox…</Text>
        ) : (
          <View className="flex-1" />
        )
      ) : (
        // FlatList virtualizes the Inbox (unbounded); @expo/ui List is native
        // but not virtualized, so it is the wrong tool here. itemLayoutAnimation
        // slides the remaining rows when one is processed; the row's own
        // entering/exiting fades it in and out.
        <AnimatedCaptureList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 96 }}
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          itemLayoutAnimation={LinearTransition.duration(200)}
          ListEmptyComponent={
            <Text variant="subtitle">
              Your inbox is empty. Capture something.
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

// Sibling of Inbox for the Today list. Duplicated deliberately (Rule of Three:
// extract a shared list screen at entity #3), so the two stay structurally
// identical. Differences: it lists open Tasks narrowed to due-on-or-before the
// local today, completes instead of processes, and the quick-add mints a Task
// dated today.
function Today({ api }: { api: TasksApi }) {
  const { data: tasks, isLoading } = useLiveQuery((q) =>
    q
      .from({ t: api.collection })
      .where(({ t }) => isNull(t.completedAt))
      .orderBy(({ t }) => t.createdAt, 'asc'),
  );
  // The live query returns all open tasks; narrow to those due on or before the
  // local today (overdue rolls in, future stays hidden), ordered by day.
  const list = useMemo(() => dueToday(tasks ?? [], localToday()), [tasks]);

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void api.refetch();
    });
    return () => sub.remove();
  }, [api]);

  const view = todayView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);

  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    setWriteError(null);
    // v1 dates a new task today; the Today list shows it immediately.
    const tx = api.add(trimmed, localToday());
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    setText('');
  }, [text, api]);

  const closeAdd = useCallback(() => {
    setText('');
    setConfirmingDiscard(false);
    setAdding(false);
  }, []);

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

  const onComplete = useCallback(
    (item: Task) => {
      setWriteError(null);
      const tx = api.complete(item.id);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Task>) => (
      <Animated.View
        entering={FadeIn.duration(150)}
        exiting={FadeOut.duration(200)}
        className="flex-row items-center gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4"
      >
        <Pressable
          accessibilityLabel={`Complete "${item.text}"`}
          className="h-7 w-7 rounded-full border-2 border-neutral-400"
          hitSlop={8}
          onPress={() => onComplete(item)}
        />
        <Text className="flex-1">{item.text}</Text>
      </Animated.View>
    ),
    [onComplete],
  );

  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);

  return (
    <>
      {error ? <Text variant="error">{error}</Text> : null}

      {view === 'loading' ? (
        showLoadingText ? (
          <Text variant="subtitle">Loading today…</Text>
        ) : (
          <View className="flex-1" />
        )
      ) : (
        <AnimatedTaskList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 96 }}
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          itemLayoutAnimation={LinearTransition.duration(200)}
          ListEmptyComponent={
            <Text variant="subtitle">Nothing for today. Add a task.</Text>
          }
        />
      )}

      <QuickAdd
        open={adding}
        text={text}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={() => onAdd()}
        onRequestClose={requestClose}
        busy={false}
        inputRef={inputRef}
        fabLabel="Add a task"
        placeholder="Add a task for today"
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
