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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, RefreshControl, SectionList, View } from 'react-native';

import { RefineBanner } from '@/components/refine-banner';
import { ScreenHeader } from '@/components/screen-header';
import { useCaptureDetail } from '@/components/capture-detail';
import { CheckCircle, ListRow } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useCapturesApi } from '@/lib/captures-collection';
import { usePullRefresh } from '@/lib/screen-hooks';
import { useColor } from '@/lib/theme';

// One upcoming row: tap the circle to Process, tap the text to open the capture
// detail — the same editor Home opens. No drag-reorder or swipe — ordering across
// days has no meaning here.
function UpcomingRow({
  item,
  onProcess,
  onOpen,
}: {
  item: Capture;
  onProcess: (item: Capture) => void;
  onOpen: (item: Capture) => void;
}) {
  return (
    <ListRow
      leading={
        <CheckCircle label={`Process "${item.text}"`} onPress={() => onProcess(item)} />
      }
      onPress={() => onOpen(item)}
      accessibilityLabel={`Edit "${item.text}"`}
    >
      <Text>{item.text}</Text>
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
  // The flat list of visible upcoming captures, so the detail editor resolves the
  // tapped capture and drops it (closing the sheet) when rescheduled to today.
  const list = useMemo(() => sections.flatMap((s) => s.data), [sections]);

  const [writeError, setWriteError] = useState<string | null>(null);

  // The capture detail editor — the same one Home opens — owns the sheet,
  // scheduler, edit-on-dismiss, complete-with-Undo, and refine.
  const detail = useCaptureDetail({ api, list, onError: setWriteError });

  // Refining a capture started here finishes here too: process the capture.
  const onFinishRefine = useCallback(
    (captureId: string) => {
      setWriteError(null);
      const tx = api.process(captureId);
      tx.isPersisted.promise.catch((e) => setWriteError(messageOf(e)));
    },
    [api],
  );

  // Android Back closes the scheduler, then the detail sheet. Upcoming has no
  // quick-add, so the hook is the only Back consumer here.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () =>
      detail.handleBack(),
    );
    return () => sub.remove();
  }, [detail]);

  const accent = useColor('--color-accent');
  const { refreshing, onRefresh } = usePullRefresh(api.refetch);

  const renderItem = useCallback(
    ({ item }: { item: Capture }) => (
      <UpcomingRow item={item} onProcess={detail.process} onOpen={detail.open} />
    ),
    [detail.process, detail.open],
  );

  return (
    <>
      <RefineBanner onFinish={onFinishRefine} />
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

      {detail.sheets}
    </>
  );
}
