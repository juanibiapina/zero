import { useEffect, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, Platform, Pressable, View } from 'react-native';
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
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility([toast.message, toast.description].filter(Boolean).join('. '));
  }, [toast]);
  useEffect(() => {
    const base = toast.action || toast.secondaryAction || toast.link || toast.descriptionAction
      ? Math.max(8000, toast.durationMs)
      : toast.durationMs;
    if (!Number.isFinite(base)) return;
    let remaining = base;
    let started = Date.now();
    let active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    let disposed = false;
    const schedule = () => {
      started = Date.now();
      defaultToastController.deferDismiss(toast, active ? remaining : Infinity);
    };
    // Hold until the platform timeout resolves, including on a slow native bridge.
    defaultToastController.deferDismiss(toast, Infinity);
    const recommendation = Platform.OS === 'android'
      ? AccessibilityInfo.getRecommendedTimeoutMillis(base)
      : Promise.resolve(base);
    let ready = false;
    void recommendation.catch(() => base).then((duration) => {
      if (disposed) return;
      remaining = Math.max(base, duration);
      ready = true;
      schedule();
    });
    const sub = AppState.addEventListener('change', (state) => {
      const next = state === 'active';
      if (next === active) return;
      if (active && ready) remaining = Math.max(0, remaining - (Date.now() - started));
      active = next;
      if (ready) schedule();
    });
    return () => {
      disposed = true;
      sub.remove();
      defaultToastController.deferDismiss(toast, remaining);
    };
  }, [toast]);
  // Animated.View is not Uniwind-mapped, so resolve its static classes to styles.
  const cardStyle = useResolveClassNames(
    'w-full max-w-[440px] rounded-2xl bg-surface px-4 py-3 shadow-raised',
  );
  const dismissAfter = (action: { onPress: () => void } | undefined) => {
    action?.onPress();
    defaultToastController.dismiss(toast.id);
  };
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      style={cardStyle}
    >
      <Text className="font-medium">{toast.message}</Text>
      {toast.description ? (
        toast.descriptionAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={toast.descriptionAction.accessibilityLabel}
            className="min-h-12 justify-center"
            onPress={() => dismissAfter(toast.descriptionAction)}
          >
            <Text variant="caption">{toast.description}</Text>
          </Pressable>
        ) : (
          <Text variant="caption">{toast.description}</Text>
        )
      ) : null}
      {toast.action || toast.secondaryAction || toast.link ? (
        <View className="flex-row flex-wrap justify-end gap-1 pt-1">
          {toast.action ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={toast.action.label}
              className="min-h-12 min-w-12 items-center justify-center px-2"
              onPress={() => dismissAfter(toast.action)}
            >
              <Text className="font-semibold text-accent">{toast.action.label}</Text>
            </Pressable>
          ) : null}
          {toast.secondaryAction ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={toast.secondaryAction.label}
              className="min-h-12 min-w-12 items-center justify-center px-2"
              onPress={() => dismissAfter(toast.secondaryAction)}
            >
              <Text className="font-semibold text-accent">{toast.secondaryAction.label}</Text>
            </Pressable>
          ) : null}
          {toast.link ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={toast.link.label}
              className="min-h-12 min-w-12 items-center justify-center px-2"
              onPress={() => dismissAfter(toast.link)}
            >
              <Text className="font-semibold text-accent">{toast.link.label}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}
