import { useEffect, type ReactNode } from 'react';
import type { ViewProps } from 'react-native';
import {
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const SETTLE_DURATION = 250;
const KEYBOARD_RETURN_WAIT = 1000;
const MATERIAL_STANDARD = Easing.bezier(0.4, 0, 0.2, 1);

export type KeyboardDockProps = ViewProps & {
  offset?: { closed?: number; opened?: number };
  hold?: boolean;
  fill?: { height: number; color: string };
  children?: ReactNode;
};

export function KeyboardDock({
  offset: { closed = 0, opened = 0 } = {},
  hold = false,
  fill,
  style,
  children,
  ...props
}: KeyboardDockProps) {
  const { height, progress } = useReanimatedKeyboardAnimation();
  const holding = useSharedValue(hold);
  const awaitingKeyboard = useSharedValue(false);
  const keyboardMoving = useSharedValue(false);
  const waitExpired = useSharedValue(0);
  const held = useSharedValue(0);
  const follow = useSharedValue(1);

  const live = () => {
    'worklet';
    return height.value + interpolate(progress.value, [0, 1], [closed, opened]);
  };
  const position = () => {
    'worklet';
    return held.value + (live() - held.value) * follow.value;
  };
  const release = () => {
    'worklet';
    awaitingKeyboard.value = false;
    follow.value = Math.abs(live() - held.value) < 1
      ? 1
      : withTiming(1, { duration: SETTLE_DURATION, easing: MATERIAL_STANDARD });
  };

  useEffect(() => {
    holding.set(hold);
    if (hold) return;
    const timer = setTimeout(() => waitExpired.set((count) => count + 1), KEYBOARD_RETURN_WAIT);
    return () => clearTimeout(timer);
  }, [hold, holding, waitExpired]);

  useKeyboardHandler(
    {
      onStart: () => {
        'worklet';
        keyboardMoving.value = true;
      },
      onEnd: (event) => {
        'worklet';
        keyboardMoving.value = false;
        if (awaitingKeyboard.value && !holding.value && event.height > 0) release();
      },
    },
    [closed, opened],
  );

  useAnimatedReaction(
    () => holding.value,
    (isHolding, wasHolding) => {
      if (wasHolding == null || isHolding === wasHolding) return;
      if (isHolding) {
        const current = position();
        cancelAnimation(follow);
        held.value = current;
        follow.value = 0;
        awaitingKeyboard.value = false;
      } else if (!keyboardMoving.value && progress.value === 1) {
        release();
      } else {
        awaitingKeyboard.value = true;
      }
    },
    [closed, opened],
  );

  useAnimatedReaction(
    () => waitExpired.value,
    (count, previous) => {
      if (previous == null || count === previous) return;
      if (awaitingKeyboard.value && !holding.value && !keyboardMoving.value) release();
    },
    [closed, opened],
  );

  const dockStyle = useAnimatedStyle(() => {
    const target = height.value + interpolate(progress.value, [0, 1], [closed, opened]);
    return { transform: [{ translateY: held.value + (target - held.value) * follow.value }] };
  }, [closed, opened]);
  const fillHeight = fill?.height ?? 0;
  const fillStyle = useAnimatedStyle(() => {
    const target = height.value + interpolate(progress.value, [0, 1], [closed, opened]);
    const translateY = held.value + (target - held.value) * follow.value;
    const exposed = follow.value < 1 ? Math.max(fillHeight, -translateY) : fillHeight;
    return {
      height: exposed,
      bottom: -exposed,
      opacity: progress.value > 0 || follow.value < 1 ? 1 : 0,
    };
  }, [closed, opened, fillHeight]);

  return (
    <Animated.View style={[style, dockStyle]} {...props}>
      {fill ? (
        <Animated.View
          pointerEvents="none"
          style={[{ position: 'absolute', left: 0, right: 0, backgroundColor: fill.color }, fillStyle]}
        />
      ) : null}
      {children}
    </Animated.View>
  );
}
