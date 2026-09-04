import { UserButton } from '@clerk/expo/native';
import { isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import {
  capturesLocalToday,
  dayLabel,
  messageOf,
  upcomingSections,
  type Capture,
  type CapturesApi,
} from '@zero/agent-core';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, SectionList, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useCapturesApi } from '@/lib/captures-collection';

// One upcoming row: tap the circle to Process, tap the text to edit inline. No
// drag-reorder or swipe — ordering across days has no meaning here, so this is a
// plain row (unlike the Captures list's gesture-driven row).
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
    <View className="flex-row items-center gap-4 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4">
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
        >
          <Text>{item.text}</Text>
        </Pressable>
      )}
    </View>
  );
}

// Upcoming lists captures scheduled for a future day, grouped into day sections.
// The complement of Captures: what has shown up stays in Captures, what is still
// ahead shows here.
export default function UpcomingScreen() {
  const capturesApi = useCapturesApi();

  return (
    <View className="flex-1 px-6 pt-16">
      <View className="mb-4 flex-row items-center justify-between">
        <Text variant="title">Upcoming</Text>
        <UserButton />
      </View>

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
      const tx = api.process(item.id);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
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
      {writeError ? <Text variant="error">{writeError}</Text> : null}

      <SectionList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 96 }}
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Text variant="subtitle" className="mb-3 mt-4">
            {dayLabel(section.date, today)}
          </Text>
        )}
        ItemSeparatorComponent={() => <View className="h-3" />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text variant="subtitle">Nothing scheduled ahead.</Text>
        }
      />
    </>
  );
}
