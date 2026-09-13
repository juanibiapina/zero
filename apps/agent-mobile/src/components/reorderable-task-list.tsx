import {
  messageOf,
  orderKeyBetween,
  tomorrow,
  type Task,
  type TasksApi,
} from '@zero/agent-core';
import type { ReactElement } from 'react';
import { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
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

import { CheckCircle } from '@/components/ui/list-row';
import { Text } from '@/components/ui/text';
import { useColor } from '@/lib/theme';

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const SWIPE_THRESHOLD = 140;

function project(velocity: number, decelerationRate = 0.998): number {
  'worklet';
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

export type TaskRowPresentation = {
  icon?: string | null;
  caption?: string | null;
  accessibilityLabel?: string;
};

function TaskRow({
  item,
  presentation,
  postponeMode,
  onComplete,
  onPostpone,
  onOpen,
}: {
  item: Task;
  presentation: TaskRowPresentation;
  postponeMode: 'exit' | 'return';
  onComplete: (item: Task) => void;
  onPostpone: (item: Task) => void;
  onOpen: (item: Task) => void;
}) {
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const drag = useReorderableDrag();
  const x = useSharedValue(0);
  const startX = useSharedValue(0);
  const ripple = useColor('--color-ripple');
  const surfaceStyle = useResolveClassNames('bg-background');

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(12)
        .failOffsetY([-6, 6])
        .onStart(() => {
          startX.set(x.get());
        })
        .onUpdate((event) => {
          x.set(Math.max(0, startX.get() + event.translationX));
        })
        .onEnd((event) => {
          const projected = x.get() + project(event.velocityX);
          if (projected <= SWIPE_THRESHOLD) {
            x.set(
              withSpring(0, {
                duration: 300,
                dampingRatio: 1,
                velocity: event.velocityX,
                reduceMotion: ReduceMotion.System,
              }),
            );
            return;
          }

          if (postponeMode === 'return') {
            scheduleOnRN(onPostpone, item);
            x.set(
              withSpring(0, {
                duration: 300,
                dampingRatio: 1,
                velocity: event.velocityX,
                reduceMotion: ReduceMotion.System,
              }),
            );
            return;
          }

          x.set(
            withTiming(
              width,
              {
                duration: 200,
                easing: EASE_OUT,
                reduceMotion: ReduceMotion.System,
              },
              (finished) => {
                if (finished) scheduleOnRN(onPostpone, item);
              },
            ),
          );
        }),
    [item, onPostpone, postponeMode, startX, width, x],
  );

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
          <Animated.View style={[surfaceStyle, rowStyle]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                presentation.accessibilityLabel ?? `Edit "${item.text}"`
              }
              android_ripple={{ color: ripple }}
              className="flex-row items-center gap-3 px-screen-x py-row-y"
              onPress={() => onOpen(item)}
              onLongPress={() => drag()}
              delayLongPress={500}
            >
              <CheckCircle
                label={`Complete "${item.text}"`}
                onPress={() => onComplete(item)}
              />
              <View className="flex-1 gap-0.5">
                <View className="flex-row items-center gap-3">
                  {presentation.icon != null ? (
                    <Text className="text-[16px]">{presentation.icon}</Text>
                  ) : null}
                  <Text className="flex-1">{item.text}</Text>
                </View>
                {presentation.caption ? (
                  <Text variant="caption">{presentation.caption}</Text>
                ) : null}
              </View>
            </Pressable>
          </Animated.View>
        </GestureDetector>
      </View>
      <View className="ml-[50px] h-px bg-divider" />
    </View>
  );
}

// One interaction module for every manually ordered task list. It owns the
// coupled horizontal swipe, long-press drag, vertical scroll, and Android
// RefreshControl rules so Home and project detail cannot drift apart.
export function ReorderableTaskList({
  api,
  tasks,
  today,
  refreshing,
  onRefresh,
  onComplete,
  onOpen,
  onError,
  presentationOf,
  postponeMode,
  header,
  footer,
  keyboardShouldPersistTaps,
}: {
  api: TasksApi;
  tasks: Task[];
  today: string;
  refreshing: boolean;
  onRefresh: () => void;
  onComplete: (item: Task) => void;
  onOpen: (item: Task) => void;
  onError: (message: string | null) => void;
  presentationOf?: (item: Task) => TaskRowPresentation;
  postponeMode: 'exit' | 'return';
  header?: ReactElement | null;
  footer?: ReactElement | null;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
}) {
  const accent = useColor('--color-accent');
  const reorderPanGesture = useMemo(
    () => Gesture.Pan().activateAfterLongPress(520),
    [],
  );
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

  const onPostpone = useCallback(
    (item: Task) => {
      onError(null);
      const transaction = api.reschedule(item.id, tomorrow(today));
      transaction.isPersisted.promise.catch((error) =>
        onError(messageOf(error)),
      );
    },
    [api, onError, today],
  );

  const onReorder = useCallback(
    ({ from, to }: ReorderableListReorderEvent) => {
      if (from === to) return;
      const moved = reorderItems(tasks, from, to);
      const item = moved[to];
      if (!item) return;
      const previous = moved[to - 1]?.sortKey ?? null;
      const next = moved[to + 1]?.sortKey ?? null;
      onError(null);
      const transaction = api.reorder(
        item.id,
        orderKeyBetween(previous, next),
      );
      transaction.isPersisted.promise.catch((error) =>
        onError(messageOf(error)),
      );
    },
    [api, onError, tasks],
  );

  const renderItem = useCallback(
    ({ item }: { item: Task }) => (
      <TaskRow
        item={item}
        presentation={presentationOf?.(item) ?? {}}
        postponeMode={postponeMode}
        onComplete={onComplete}
        onPostpone={onPostpone}
        onOpen={onOpen}
      />
    ),
    [onComplete, onOpen, onPostpone, postponeMode, presentationOf],
  );

  return (
    <ReorderableList
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1, paddingBottom: 96 }}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          enabled={refreshEnabled}
          tintColor={accent}
          colors={[accent]}
        />
      }
      data={tasks}
      keyExtractor={(item) => item.id}
      panGesture={reorderPanGesture}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      itemLayoutAnimation={LinearTransition.duration(200)}
      onReorder={onReorder}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    />
  );
}
