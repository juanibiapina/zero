import { UserButton } from '@clerk/expo/native';
import { useLiveQuery } from '@tanstack/react-db';
import {
  projectsView,
  type Project,
  type ProjectsApi,
} from '@zero/agent-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  FlatList,
  type TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { QuickAdd } from '@/components/quick-add';
import { Text } from '@/components/ui/text';
import { useProjectsApi } from '@/lib/use-projects-api';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Helper text (not the placeholder): teach outcome-based naming, the one
// deliberate act of creating a project.
const NAME_HELPER = "Name the outcome you'll reach, so you know when it's done.";

// How long a list may sit empty-and-loading before it shows the "Loading…"
// text, so a cached cold start never flashes it. Mirrors the Captures screen.
const LOADING_TEXT_DELAY_MS = 1000;

function useDelayed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setElapsed(true), ms);
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

// A read-only project row: emoji icon + title. Status, notes, and editing are
// enriched later (slices A2/A3) from a detail sheet.
function ProjectRow({ item }: { item: Project }) {
  return (
    <View className="flex-row items-center gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4">
      <Text className="text-xl">{item.icon}</Text>
      <Text className="flex-1 text-base text-neutral-900">{item.title}</Text>
    </View>
  );
}

function Separator() {
  return <View className="h-3" />;
}

// Projects is entity #3: a flat list of outcome-oriented containers. The
// quick-add creates a Project by name; status/icon/notes come later.
export default function ProjectsScreen() {
  const projectsApi = useProjectsApi();

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
        <Text variant="title">Projects</Text>
        <UserButton />
      </View>

      {projectsApi ? (
        <Projects api={projectsApi} bottomOffset={bottomOffset} />
      ) : (
        <View className="flex-1" />
      )}
    </View>
  );
}

function Projects({
  api,
  bottomOffset,
}: {
  api: ProjectsApi;
  bottomOffset: number;
}) {
  const { data: projects, isLoading } = useLiveQuery((q) =>
    q.from({ p: api.collection }).orderBy(({ p }) => p.createdAt, 'asc'),
  );
  const list = projects ?? [];

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Refresh when the app returns to the foreground, so a list changed elsewhere
  // shows up without a cold start.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void api.refetch();
    });
    return () => sub.remove();
  }, [api]);

  const view = projectsView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);

  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Submitting an empty input closes the quick-add bar.
      setAdding(false);
      return;
    }
    setWriteError(null);
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    // Keep the bar open and cleared for rapid, repeated creation.
    setText('');
  }, [text, api]);

  const closeAdd = useCallback(() => {
    setText('');
    setAdding(false);
  }, []);

  // Android hardware / navigation back: close the open bar instead of leaving
  // the screen. Empty bar closes silently (no unsaved-text confirm in A1).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (adding) {
        closeAdd();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [adding, closeAdd]);

  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);

  return (
    <>
      {error ? <Text variant="error">{error}</Text> : null}

      {view === 'loading' ? (
        showLoadingText ? (
          <Text variant="subtitle">Loading your projects…</Text>
        ) : (
          <View className="flex-1" />
        )
      ) : (
        <FlatList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 96 }}
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ProjectRow item={item} />}
          ItemSeparatorComponent={Separator}
          ListEmptyComponent={
            <Text variant="subtitle">
              No projects yet. Name your first outcome.
            </Text>
          }
        />
      )}

      <QuickAdd
        open={adding}
        text={text}
        onChangeText={setText}
        onOpen={() => setAdding(true)}
        onSubmit={() => onAdd()}
        onRequestClose={closeAdd}
        busy={false}
        inputRef={inputRef}
        fabLabel="New project"
        placeholder="Run a 5K under 30 min"
        helperText={NAME_HELPER}
        bottomOffset={bottomOffset}
      />
    </>
  );
}
