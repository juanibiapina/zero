import type { ReactElement, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, View } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import ReorderableList, {
  reorderItems,
  useReorderableDrag,
  type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';
import { LinearTransition } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { CheckCircle } from '@/components/ui/list-row';
import { useColor } from '@/lib/theme';

// The pressable body of a manually ordered checklist row: the check circle and
// the content. Tap opens the item, and a long press starts a drag in the
// surrounding ReorderableChecklist. Task rows wrap it in their swipe gesture.
export function ChecklistPressable({
  checkLabel,
  onCheck,
  onPress,
  accessibilityLabel,
  children,
}: {
  checkLabel: string;
  onCheck: () => void;
  onPress: () => void;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  const drag = useReorderableDrag();
  const ripple = useColor('--color-ripple');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      android_ripple={{ color: ripple }}
      className="flex-row items-center gap-3 px-screen-x py-row-y"
      onPress={onPress}
      onLongPress={() => drag()}
      delayLongPress={500}
    >
      <CheckCircle label={checkLabel} onPress={onCheck} />
      <View className="flex-1 gap-0.5">{children}</View>
    </Pressable>
  );
}

// The hairline under a checklist row, inset to the text: screen-x (16) +
// circle (22) + gap (12).
export function ChecklistDivider() {
  return <View className="ml-[50px] h-px bg-divider" />;
}

// A checklist row without a swipe action.
export function ChecklistRow(props: Parameters<typeof ChecklistPressable>[0]) {
  return (
    <View className="bg-background">
      <ChecklistPressable {...props} />
      <ChecklistDivider />
    </View>
  );
}

// One interaction module for every manually ordered checklist. It owns the
// long-press drag, vertical scroll, and Android RefreshControl rules, and
// reports a drop as the item and its new index in `items`.
export function ReorderableChecklist<T extends { id: string }>({
  items,
  renderItem,
  onMove,
  refreshing,
  onRefresh,
  header,
  footer,
  empty,
  keyboardShouldPersistTaps,
}: {
  items: T[];
  renderItem: (item: T) => ReactElement;
  onMove: (item: T, toIndex: number, reordered: T[]) => void;
  refreshing: boolean;
  onRefresh: () => void;
  header?: ReactElement | null;
  footer?: ReactElement | null;
  empty?: ReactElement | null;
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

  const onReorder = useCallback(
    ({ from, to }: ReorderableListReorderEvent) => {
      if (from === to) return;
      const reordered = reorderItems(items, from, to);
      const item = reordered[to];
      if (item) onMove(item, to, reordered);
    },
    [items, onMove],
  );

  const render = useCallback(({ item }: { item: T }) => renderItem(item), [renderItem]);

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
      data={items}
      keyExtractor={(item) => item.id}
      panGesture={reorderPanGesture}
      renderItem={render}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      itemLayoutAnimation={LinearTransition.duration(200)}
      onReorder={onReorder}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    />
  );
}
