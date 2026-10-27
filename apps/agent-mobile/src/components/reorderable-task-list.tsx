import { taskRecurrenceLabel } from '@zero/agent-core';
import { TaskRecurrence } from '@/components/task-recurrence';
import {
  messageOf,
  orderKeyBetween,
  tomorrow,
  type Task,
  type TodoTasks,
} from '@zero/agent-core';
import type { ReactElement } from 'react';
import { useCallback, useMemo } from 'react';
import {
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useResolveClassNames } from 'uniwind';

import { ChecklistDivider, ChecklistPressable, ReorderableChecklist } from '@/components/reorderable-checklist';
import { Text } from '@/components/ui/text';

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

type TaskSwipeAction = 'postpone-tomorrow' | 'schedule-today';

function TaskRow({
  item,
  presentation,
  swipeAction,
  onComplete,
  onSwipe,
  onOpen,
}: {
  item: Task;
  presentation: TaskRowPresentation;
  swipeAction: TaskSwipeAction;
  onComplete: (item: Task) => void;
  onSwipe: (item: Task) => void;
  onOpen: (item: Task) => void;
}) {
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const x = useSharedValue(0);
  const startX = useSharedValue(0);
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

          if (swipeAction === 'schedule-today') {
            scheduleOnRN(onSwipe, item);
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
                if (finished) scheduleOnRN(onSwipe, item);
              },
            ),
          );
        }),
    [item, onSwipe, startX, swipeAction, width, x],
  );

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: reduced ? 0 : x.get() }],
  }));

  return (
    <View className="bg-background">
      <View className="overflow-hidden bg-background">
        <View
          style={StyleSheet.absoluteFill}
          className="flex-row items-center bg-swipe-schedule px-screen-x"
        >
          <Text className="font-medium text-on-accent">
            {swipeAction === 'schedule-today' ? 'Today' : 'Tomorrow'}
          </Text>
        </View>
        <GestureDetector gesture={pan}>
          <Animated.View style={[surfaceStyle, rowStyle]}>
            <ChecklistPressable
              accessibilityLabel={
                [presentation.accessibilityLabel ?? `Edit "${item.text}"`, taskRecurrenceLabel(item)].filter(Boolean).join(', ')
              }
              checkLabel={`Complete "${item.text}"`}
              onCheck={() => onComplete(item)}
              onPress={() => onOpen(item)}
            >
              <View className="flex-row items-center gap-3">
                {presentation.icon != null ? (
                  <Text className="text-[16px]">{presentation.icon}</Text>
                ) : null}
                <Text className="flex-1">{item.text}</Text>
              </View>
              <TaskRecurrence task={item} />
              {presentation.caption ? (
                <Text variant="caption">{presentation.caption}</Text>
              ) : null}
            </ChecklistPressable>
          </Animated.View>
        </GestureDetector>
      </View>
      <ChecklistDivider />
    </View>
  );
}

// The Task adapter over ReorderableChecklist: it adds the horizontal date
// swipe, the Task row content, and turns a drop into a sort key, so Home and
// project detail cannot drift apart.
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
  swipeAction,
  header,
  footer,
  empty,
  keyboardShouldPersistTaps,
}: {
  api: TodoTasks;
  tasks: Task[];
  today: string;
  refreshing: boolean;
  onRefresh: () => void;
  onComplete: (item: Task) => void;
  onOpen: (item: Task) => void;
  onError: (message: string | null) => void;
  presentationOf?: (item: Task) => TaskRowPresentation;
  swipeAction: TaskSwipeAction;
  header?: ReactElement | null;
  footer?: ReactElement | null;
  empty?: ReactElement | null;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
}) {
  const onSwipe = useCallback(
    (item: Task) => {
      onError(null);
      const targetDate =
        swipeAction === 'schedule-today' ? today : tomorrow(today);
      const transaction = api.reschedule(item.id, targetDate);
      transaction.isPersisted.promise.catch((error) =>
        onError(messageOf(error)),
      );
    },
    [api, onError, swipeAction, today],
  );

  const onMove = useCallback(
    (item: Task, to: number, reordered: Task[]) => {
      const previous = reordered[to - 1]?.sortKey ?? null;
      const next = reordered[to + 1]?.sortKey ?? null;
      onError(null);
      const transaction = api.reorder(
        item.id,
        orderKeyBetween(previous, next),
      );
      transaction.isPersisted.promise.catch((error) =>
        onError(messageOf(error)),
      );
    },
    [api, onError],
  );

  const renderItem = useCallback(
    (item: Task) => (
      <TaskRow
        item={item}
        presentation={presentationOf?.(item) ?? {}}
        swipeAction={swipeAction}
        onComplete={onComplete}
        onSwipe={onSwipe}
        onOpen={onOpen}
      />
    ),
    [onComplete, onOpen, onSwipe, presentationOf, swipeAction],
  );

  return (
    <ReorderableChecklist
      items={tasks}
      renderItem={renderItem}
      onMove={onMove}
      refreshing={refreshing}
      onRefresh={onRefresh}
      header={header}
      footer={footer}
      empty={empty}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
    />
  );
}
