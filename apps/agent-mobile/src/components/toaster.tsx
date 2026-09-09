import { useSyncExternalStore } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useResolveClassNames } from 'uniwind';

import { defaultToastController, type Toast } from '@zero/agent-core';

import { Text } from '@/components/ui/text';

// Mobile renderer adapter over the shared, headless toast controller
// (@zero/agent-core). It only paints the controller's snapshot; queueing, timers
// and de-duplication live in the controller. Mounted once at the app root (see
// app/_layout.tsx).
//
// Deliberately simple to sidestep the react-native-screens + reanimated failure
// that sank sonner-native on this stack (see docs/plans/toast-primitive.md): a
// fixed top position (no height measurement, no stacking math) and the same
// FadeIn/FadeOut layout animation the quick-add already runs on-device. Exit
// plays on unmount when the controller drops the toast.

function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    defaultToastController.subscribe,
    defaultToastController.getSnapshot,
    defaultToastController.getSnapshot,
  );
}

// The native Material bottom tab bar's content height (labelled tabs, ~80dp),
// excluding the safe-area inset which is added separately. The toast docks a
// comfortable margin above the whole bar, Todoist-style, so it never overlaps
// the tabs.
const TAB_BAR_HEIGHT = 80;
const TOAST_GAP = 16;

export function Toaster() {
  const toasts = useToasts();
  const insets = useSafeAreaInsets();
  return (
    // box-none lets taps through everywhere except a toast row. Elevation +
    // zIndex keep it above content and the native tab/stack surfaces. Anchored to
    // the bottom, sitting clear above the tab bar.
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 items-center gap-2 px-screen-x"
      style={{
        bottom: insets.bottom + TAB_BAR_HEIGHT + TOAST_GAP,
        zIndex: 9999,
        elevation: 9999,
      }}
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </View>
  );
}

function ToastRow({ toast }: { toast: Toast }) {
  // Animated.View is not Uniwind-mapped, so resolve its static classes to styles.
  const cardStyle = useResolveClassNames(
    'w-full max-w-[440px] flex-row items-center gap-3 rounded-2xl bg-surface px-4 py-3 shadow-raised',
  );
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      style={cardStyle}
    >
      <View className="flex-1">
        <Text className="font-medium" numberOfLines={1}>
          {toast.message}
        </Text>
        {toast.description ? (
          <Text variant="caption" numberOfLines={1}>
            {toast.description}
          </Text>
        ) : null}
      </View>
      {toast.action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toast.action.label}
          hitSlop={8}
          onPress={() => {
            toast.action?.onPress();
            defaultToastController.dismiss(toast.id);
          }}
        >
          <Text className="font-semibold text-accent">{toast.action.label}</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}
