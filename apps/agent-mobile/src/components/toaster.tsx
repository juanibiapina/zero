import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePathname } from 'expo-router';
import {
  AccessibilityInfo,
  AppState,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
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
// fixed position (no height measurement or dynamic stacking math) and the same
// FadeIn/FadeOut layout animation the quick-add already runs on-device. Exit
// plays on unmount when the controller drops the toast.

function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    defaultToastController.subscribe,
    defaultToastController.getSnapshot,
    defaultToastController.getSnapshot,
  );
}

// The native Material bottom tab bar excludes the safe-area inset. A medium FAB
// sits 24dp above that content edge and is 56dp tall. Reserve the whole lane so
// the toast's lower edge stays 16dp above the plus button on every tab.
const TAB_BAR_HEIGHT = 80;
const FAB_BOTTOM_SPACING = 24;
const FAB_DIAMETER = 56;
const TOAST_GAP = 16;

const SWIPE_THRESHOLD = 96;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

function project(velocity: number, decelerationRate = 0.998): number {
  'worklet';
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

export function Toaster() {
  const toasts = useToasts();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const previousPath = useRef(pathname);

  useEffect(() => {
    let foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    if (!foreground) defaultToastController.dismiss();
    const appState = AppState.addEventListener('change', (state) => {
      foreground = state === 'active';
      if (!foreground) defaultToastController.dismiss();
    });
    const unsubscribe = defaultToastController.subscribe(() => {
      if (!foreground) defaultToastController.dismiss();
    });
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      defaultToastController.dismiss();
    }
  }, [pathname]);

  return (
    // box-none lets taps through everywhere except a toast row. Elevation +
    // zIndex keep it above content and the native tab/stack surfaces. Anchored to
    // the bottom, sitting clear above the tab bar.
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 items-center gap-2 px-screen-x"
      style={{
        bottom:
          insets.bottom +
          TAB_BAR_HEIGHT +
          FAB_BOTTOM_SPACING +
          FAB_DIAMETER +
          TOAST_GAP,
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
  const { width, fontScale } = useWindowDimensions();
  const x = useSharedValue(0);
  const startX = useSharedValue(0);
  const dismissSwipedToast = useCallback(() => {
    // Ignore a stale row if a caller replaced this toast id while it slid out.
    defaultToastController.deferDismiss(toast, 0);
  }, [toast]);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-12, 12])
        .failOffsetY([-8, 8])
        .onStart(() => {
          startX.set(x.get());
        })
        .onUpdate((event) => {
          x.set(startX.get() + event.translationX);
        })
        .onEnd((event) => {
          const projected = x.get() + project(event.velocityX);
          if (Math.abs(projected) < SWIPE_THRESHOLD) {
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

          const direction = projected < 0 ? -1 : 1;
          x.set(
            withTiming(
              direction * width,
              {
                duration: 200,
                easing: EASE_OUT,
                reduceMotion: ReduceMotion.System,
              },
              (finished) => {
                if (finished) scheduleOnRN(dismissSwipedToast);
              },
            ),
          );
        }),
    [dismissSwipedToast, startX, width, x],
  );
  const swipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }],
  }));

  useEffect(() => {
    x.set(0);
  }, [toast, x]);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility([toast.message, toast.description].filter(Boolean).join('. '));
  }, [toast]);
  useEffect(() => {
    const base = toast.durationMs;
    if (!Number.isFinite(base) || Platform.OS !== 'android') return;
    const started = Date.now();
    let disposed = false;
    // Keep the toast until Android supplies its recommended accessibility
    // timeout, then count that duration from when this row appeared.
    defaultToastController.deferDismiss(toast, Infinity);
    void AccessibilityInfo.getRecommendedTimeoutMillis(base).catch(() => base).then((duration) => {
      if (!disposed) {
        defaultToastController.deferDismiss(toast, Math.max(0, Math.max(base, duration) - (Date.now() - started)));
      }
    });
    return () => {
      disposed = true;
      defaultToastController.deferDismiss(toast, Math.max(0, base - (Date.now() - started)));
    };
  }, [toast]);
  const compact = width >= 360 && fontScale <= 1.3;
  // Animated.View is not Uniwind-mapped, so resolve its static classes to styles.
  const cardStyle = useResolveClassNames(
    'w-full max-w-[440px] min-h-14 flex-row flex-wrap items-center rounded-xl bg-surface-muted px-3 py-1',
  );
  const dismissAfter = (action: { onPress: () => void } | undefined) => {
    action?.onPress();
    defaultToastController.dismiss(toast.id);
  };
  const content = (
    <>
      <Text className={toast.description ? 'shrink-0 font-medium' : 'min-w-0 flex-1 font-medium'}>
        {toast.message}
      </Text>
      {toast.description ? (
        <Text
          className={`min-w-0 flex-1 ${toast.descriptionAction ? 'text-toast-action' : 'text-foreground-secondary'}`}
          numberOfLines={compact ? 1 : undefined}
        >
          {` · ${toast.description}`}
        </Text>
      ) : null}
    </>
  );
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        onTouchStart={(event) => event.stopPropagation()}
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(150)}
        style={[cardStyle, swipeStyle]}
      >
        {toast.descriptionAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={toast.descriptionAction.accessibilityLabel}
            className={`${compact ? 'flex-1' : 'w-full'} min-h-12 min-w-0 flex-row items-center`}
            onPress={() => dismissAfter(toast.descriptionAction)}
          >
            {content}
          </Pressable>
        ) : (
          <View className={`${compact ? 'flex-1' : 'w-full'} min-h-12 min-w-0 flex-row items-center`}>
            {content}
          </View>
        )}
        {toast.action || toast.secondaryAction || toast.link ? (
          <View className={`${compact ? 'shrink-0' : 'w-full'} flex-row flex-wrap items-center justify-end`}>
            {toast.action ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={toast.action.accessibilityLabel ?? toast.action.label}
                className="min-h-12 min-w-12 items-center justify-center px-1"
                onPress={() => dismissAfter(toast.action)}
              >
                <Text variant="subtitle" className="font-semibold text-toast-action">{toast.action.label}</Text>
              </Pressable>
            ) : null}
            {toast.secondaryAction ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={toast.secondaryAction.accessibilityLabel ?? toast.secondaryAction.label}
                className="min-h-12 min-w-12 items-center justify-center px-1"
                onPress={() => dismissAfter(toast.secondaryAction)}
              >
                <Text variant="subtitle" className="font-semibold text-toast-action">{toast.secondaryAction.label}</Text>
              </Pressable>
            ) : null}
            {toast.link ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={toast.link.accessibilityLabel ?? toast.link.label}
                className="min-h-12 min-w-12 items-center justify-center px-1"
                onPress={() => dismissAfter(toast.link)}
              >
                <Text variant="subtitle" className="font-semibold text-toast-action">{toast.link.label}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}
