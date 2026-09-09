import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  capturesLocalToday,
  dayLabel,
  messageOf,
  undoableAction,
  upcomingSections,
  type Capture,
  type CapturesApi,
} from '@zero/agent-core';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, SectionList, TextInput, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { CheckCircle, ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useCapturesApi } from '@/lib/captures-collection';
import { usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

// One upcoming row: tap the circle to Process, tap the text to edit inline. No
// drag-reorder or swipe — ordering across days has no meaning here.
function UpcomingRow({
  item,
  editing,
  editText,
  onProcess,
  onEditSubmit,
  onChangeEditText,
  onStartEdit,
}: {
  item: Capture;
  editing: boolean;
  editText: string;
  onProcess: (item: Capture) => void;
  onEditSubmit: (item: Capture) => void;
  onChangeEditText: (text: string) => void;
  onStartEdit: (item: Capture) => void;
}) {
  return (
    <ListRow
      leading={
        <CheckCircle label={`Process "${item.text}"`} onPress={() => onProcess(item)} />
      }
      onPress={editing ? undefined : () => onStartEdit(item)}
      accessibilityLabel={`Edit "${item.text}"`}
    >
      {editing ? (
        <TextInput
          autoFocus
          accessibilityLabel={`Edit "${item.text}"`}
          className="text-body text-foreground"
          value={editText}
          onChangeText={onChangeEditText}
          onSubmitEditing={() => onEditSubmit(item)}
          onBlur={() => onEditSubmit(item)}
          returnKeyType="done"
        />
      ) : (
        <Text>{item.text}</Text>
      )}
    </ListRow>
  );
}

// Upcoming lists captures scheduled for a future day, grouped into day sections.
// The complement of Captures: what has shown up stays in Captures, what is still
// ahead shows here.
export default function UpcomingScreen() {
  const capturesApi = useCapturesApi();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Upcoming" />
      {capturesApi ? <Upcoming api={capturesApi} /> : <View className="flex-1" />}
    </View>
  );
}

function Upcoming({ api }: { api: CapturesApi }) {
  const { data: captures } = useLiveQuery((q) =>
    q.from({ c: api.collection }).where(({ c }) => isNull(c.processedAt)),
  );

  const today = capturesLocalToday();
  const sections = useMemo(
    () =>
      upcomingSections(captures ?? [], today).map((s) => ({
        date: s.date,
        data: s.captures,
      })),
    [captures, today],
  );

  const [writeError, setWriteError] = useState<string | null>(null);

  const onProcess = useCallback(
    (item: Capture) => {
      setWriteError(null);
      // Same single bottom Undo snackbar as elsewhere; Undo returns the capture.
      undoableAction({
        message: 'Completed',
        act: () => api.process(item.id),
        undo: () => api.unprocess(item.id),
        onError: setWriteError,
      });
    },
    [api],
  );

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

  const accent = useColor('--color-accent');
  const { refreshing, onRefresh } = usePullRefresh(api.refetch);

  const renderItem = useCallback(
    ({ item }: { item: Capture }) => (
      <UpcomingRow
        item={item}
        editing={editingId === item.id}
        editText={editText}
        onProcess={onProcess}
        onEditSubmit={onEditSubmit}
        onChangeEditText={setEditText}
        onStartEdit={onStartEdit}
      />
    ),
    [onProcess, editingId, editText, onEditSubmit, onStartEdit],
  );

  return (
    <>
      {writeError ? (
        <Text variant="error" className="px-screen-x">
          {writeError}
        </Text>
      ) : null}

      <SectionList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 96 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={accent}
            colors={[accent]}
          />
        }
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <View className="bg-background px-screen-x pb-2 pt-6">
            <Text variant="section">{dayLabel(section.date, today)}</Text>
            <View className="mt-2 h-px bg-divider" />
          </View>
        )}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text variant="subtitle" className="px-screen-x">
            Nothing scheduled ahead.
          </Text>
        }
      />
    </>
  );
}
