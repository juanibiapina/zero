import { UserButton } from '@clerk/expo/native';
import { Button, Column, Row, Text as UIText, TextInput } from '@expo/ui';
import { useLiveQuery } from '@tanstack/react-db';
import {
  ALL_STATUSES,
  BACKLOG_COLLAPSE_THRESHOLD,
  DONE_UNDO_MS,
  ICON_CHOICES,
  LOADING_TEXT_DELAY_MS,
  messageOf,
  projectsByStatus,
  listView,
  STATUS_LABELS,
  type Project,
  type ProjectEditFields,
  type ProjectsApi,
  type ProjectStatus,
} from '@zero/agent-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  SectionList,
  type TextInput as RNTextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { QuickAdd } from '@/components/quick-add';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useProjectsApi } from '@/lib/projects-collection';
import {
  useDelayed,
  useForegroundRefetch,
  useLoadError,
  useUndoableLeave,
} from '@/lib/screen-hooks';

// Helper text (not the placeholder): teach outcome-based naming, the one
// deliberate act of creating a project.
const NAME_HELPER = "Name the outcome you'll reach, so you know when it's done.";

// A project row: emoji icon + title, a single tap target that opens the detail
// sheet. While mid-Done it is struck-through with an Undo instead of tappable.
function ProjectRow({
  item,
  pending,
  onOpen,
  onUndo,
}: {
  item: Project;
  // Mid-Done or mid-Delete: struck-through with an Undo instead of tappable.
  pending: boolean;
  onOpen: (p: Project) => void;
  onUndo: (id: string) => void;
}) {
  if (pending) {
    return (
      <View className="flex-row items-center gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4">
        <Text className="text-xl">{item.icon}</Text>
        <Text className="flex-1 text-base text-neutral-400 line-through">
          {item.title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo"
          hitSlop={8}
          onPress={() => onUndo(item.id)}
        >
          <Text className="font-semibold text-primary">Undo</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={() => onOpen(item)}
      className="flex-row items-center gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4"
    >
      <Text className="text-xl">{item.icon}</Text>
      <Text className="flex-1 text-base text-neutral-900">{item.title}</Text>
    </Pressable>
  );
}

// A collapsible sticky section header: label, count, and a collapse toggle.
function SectionHeader({
  status,
  count,
  collapsed,
  onToggle,
}: {
  status: ProjectStatus;
  count: number;
  collapsed: boolean;
  onToggle: (status: ProjectStatus, current: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${STATUS_LABELS[status]}, ${count}`}
      onPress={() => onToggle(status, collapsed)}
      className="flex-row items-center gap-2 bg-white py-2"
    >
      <Text className="text-sm font-semibold text-neutral-500">
        {collapsed ? '▸' : '▾'} {STATUS_LABELS[status]}
      </Text>
      <Text className="text-sm text-neutral-400">· {count}</Text>
    </Pressable>
  );
}

// The Status group rendered inside the native sheet, built with @expo/ui so it
// is a real native control tree. The current status is a filled button (its
// mark); the others are outlined. Tapping the current one is a no-op the caller
// handles by just closing the sheet.
function StatusGroup({
  current,
  onPick,
}: {
  current: ProjectStatus;
  onPick: (status: ProjectStatus) => void;
}) {
  return (
    <Column spacing={8}>
      <UIText>Status</UIText>
      {ALL_STATUSES.map((status) => (
        <Button
          key={status}
          variant={status === current ? 'filled' : 'outlined'}
          onPress={() => onPick(status)}
          label={status === current ? `${STATUS_LABELS[status]} ✓` : STATUS_LABELS[status]}
        />
      ))}
    </Column>
  );
}

// The detail sheet body (native @expo/ui tree): an icon picker, an editable
// title and notes field, and the Status group. Edits commit on blur/submit (not
// per keystroke) and keep the sheet open; only a status pick dismisses it. Keyed
// by project id at the call site, so the seeded field state resets per project.
function ProjectDetail({
  project,
  onEdit,
  onPickStatus,
  onDelete,
}: {
  project: Project;
  onEdit: (id: string, fields: ProjectEditFields) => void;
  onPickStatus: (status: ProjectStatus) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? '');

  const commitTitle = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed === '' || trimmed === project.title) {
      setTitle(project.title);
      return;
    }
    onEdit(project.id, { title: trimmed });
  }, [title, project.id, project.title, onEdit]);

  const commitDescription = useCallback(() => {
    const next = description.trim() === '' ? null : description;
    if ((next ?? null) === (project.description ?? null)) return;
    onEdit(project.id, { description: next });
  }, [description, project.id, project.description, onEdit]);

  return (
    <Column spacing={12}>
      <UIText>Icon</UIText>
      <Row spacing={8}>
        {ICON_CHOICES.map((icon) => (
          <Button
            key={icon}
            variant={icon === project.icon ? 'filled' : 'outlined'}
            onPress={() => onEdit(project.id, { icon })}
            label={icon}
          />
        ))}
      </Row>

      <UIText>Title</UIText>
      <TextInput
        defaultValue={project.title}
        onChangeText={setTitle}
        onBlur={commitTitle}
        returnKeyType="done"
        onSubmitEditing={commitTitle}
        placeholder="Project name"
      />

      <UIText>Notes</UIText>
      <TextInput
        defaultValue={project.description ?? ''}
        onChangeText={setDescription}
        onBlur={commitDescription}
        multiline
        placeholder="A sentence of intent (optional)"
      />

      <StatusGroup current={project.status} onPick={onPickStatus} />

      {/* Destructive: hard-delete the project (distinct from Done, which keeps
          it). Leaves a brief Undo window before it commits. A plain Pressable
          with red text, since @expo/ui Button has no destructive role. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Delete project"
        onPress={onDelete}
        className="items-center py-3"
      >
        <Text className="font-semibold text-red-600">Delete project</Text>
      </Pressable>
    </Column>
  );
}

// Projects is entity #3: outcome-oriented containers grouped by status. The
// quick-add creates one by name; tapping a row opens the detail sheet where the
// status is changed (icon/title/notes editing is slice A3).
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
  const list = useMemo(() => projects ?? [], [projects]);

  const loadError = useLoadError(api);
  const [writeError, setWriteError] = useState<string | null>(null);

  // The open sheet's project id; the projects mid-Done; and per-section collapse
  // overrides (only sections the user explicitly toggled; the rest fall back to
  // the default below). Collapse is client-only UI state (not persisted).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapseOverride, setCollapseOverride] = useState<
    Partial<Record<ProjectStatus, boolean>>
  >({});
  // Two deferred-undo channels: one for Done, one for Delete. Both hold a row
  // struck-through with an Undo for DONE_UNDO_MS before committing; the hook
  // owns the timers and their cleanup.
  const done = useUndoableLeave(DONE_UNDO_MS);
  const del = useUndoableLeave(DONE_UNDO_MS);

  // Refresh when the app returns to the foreground.
  useForegroundRefetch(api.refetch);

  const commitStatus = useCallback(
    (id: string, status: ProjectStatus) => {
      setWriteError(null);
      const tx = api.setStatus(id, status);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
  );

  // Edit a project's icon/title/notes from the sheet. Unlike a status pick, an
  // edit keeps the sheet open so several fields can change.
  const commitEdit = useCallback(
    (id: string, fields: ProjectEditFields) => {
      setWriteError(null);
      const tx = api.edit(id, fields);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
  );

  // Setting Done and deleting both defer their write behind a DONE_UNDO_MS Undo
  // window (delete is destructive with no server-side undo, so the window is the
  // only guard against a mis-tap).
  const startDelete = useCallback(
    (id: string) => {
      del.start(id, () => {
        setWriteError(null);
        const tx = api.remove(id);
        tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
      });
    },
    [del, api],
  );

  // Route an Undo tap to the pending action that owns the row.
  const onUndo = useCallback(
    (id: string) => {
      if (del.pending.has(id)) del.undo(id);
      else done.undo(id);
    },
    [del, done],
  );

  const onPickStatus = useCallback(
    (project: Project, status: ProjectStatus) => {
      setSelectedId(null);
      if (status === project.status) return;
      if (status === 'done') {
        done.start(project.id, () => commitStatus(project.id, 'done'));
      } else {
        commitStatus(project.id, status);
      }
    },
    [commitStatus, done],
  );

  const onToggle = useCallback((status: ProjectStatus, current: boolean) => {
    setCollapseOverride((prev) => ({ ...prev, [status]: !current }));
  }, []);

  const view = listView({ count: list.length, isLoading, loadError });
  const error = writeError ?? (list.length === 0 ? loadError : null);
  const showLoadingText = useDelayed(view === 'loading', LOADING_TEXT_DELAY_MS);

  const grouped = useMemo(() => projectsByStatus(list), [list]);

  // Collapse is derived, not stored: a section uses the user's explicit override
  // when present, else the default (a large Backlog starts collapsed; the other
  // working statuses start open). A collapsed section keeps its header (with the
  // count) but renders no rows.
  const sections = useMemo(
    () =>
      grouped.map((s) => {
        const count = s.projects.length;
        const isCollapsed =
          collapseOverride[s.status] ??
          (s.status === 'backlog' && count > BACKLOG_COLLAPSE_THRESHOLD);
        return {
          status: s.status,
          count,
          data: isCollapsed ? [] : s.projects,
          collapsed: isCollapsed,
        };
      }),
    [grouped, collapseOverride],
  );

  // Android back: dismiss the sheet, then close the quick-add, before leaving.
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<RNTextInput>(null);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedId) {
        setSelectedId(null);
        return true;
      }
      if (adding) {
        setText('');
        setAdding(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selectedId, adding]);

  const onAdd = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    setWriteError(null);
    const tx = api.add(trimmed);
    tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    setText('');
  }, [text, api]);

  const closeAdd = useCallback(() => {
    setText('');
    setAdding(false);
  }, []);

  const selected = selectedId
    ? (list.find((p) => p.id === selectedId) ?? null)
    : null;

  return (
    <>
      {error ? <Text variant="error">{error}</Text> : null}

      {view === 'loading' ? (
        showLoadingText ? (
          <Text variant="subtitle">Loading your projects…</Text>
        ) : (
          <View className="flex-1" />
        )
      ) : view === 'empty' ? (
        <Text variant="subtitle">No projects yet. Name your first outcome.</Text>
      ) : (
        <SectionList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 96 }}
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled
          renderSectionHeader={({ section }) => (
            <SectionHeader
              status={section.status}
              count={section.count}
              collapsed={section.collapsed}
              onToggle={onToggle}
            />
          )}
          renderItem={({ item }) => (
            <ProjectRow
              item={item}
              pending={done.pending.has(item.id) || del.pending.has(item.id)}
              onOpen={(p) => setSelectedId(p.id)}
              onUndo={onUndo}
            />
          )}
          ItemSeparatorComponent={() => <View className="h-3" />}
          SectionSeparatorComponent={() => <View className="h-2" />}
        />
      )}

      <Sheet open={selected != null} onClose={() => setSelectedId(null)}>
        {selected ? (
          <ProjectDetail
            key={selected.id}
            project={selected}
            onEdit={commitEdit}
            onPickStatus={(status) => onPickStatus(selected, status)}
            onDelete={() => {
              setSelectedId(null);
              startDelete(selected.id);
            }}
          />
        ) : null}
      </Sheet>

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
