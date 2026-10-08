import type { MedicineSlot } from '@zero/agent-core';
import { useEffect, useState } from 'react';
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { ReduceMotion, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Text } from '@/components/ui/text';

const DAY = 24 * 60;
const STEP = 15;
const FIRST = STEP;
const LAST = DAY - STEP;
const HIT = 48;
const KNOB = 32;
const HOURS = [0, 6, 12, 18, 24];

const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const toClock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const usable = (minutes: number, occupied: number[]) => minutes >= FIRST && minutes <= LAST && !occupied.includes(minutes);

function nearestFree(target: number, occupied: number[]): number | null {
  const start = Math.min(LAST, Math.max(FIRST, Math.round(target / STEP) * STEP));
  for (let distance = 0; distance <= DAY; distance += STEP) {
    if (usable(start + distance, occupied)) return start + distance;
    if (usable(start - distance, occupied)) return start - distance;
  }
  return null;
}

function nextFree(from: number, direction: 1 | -1, occupied: number[]): number | null {
  for (let minutes = from + direction * STEP; minutes >= FIRST && minutes <= LAST; minutes += direction * STEP) {
    if (!occupied.includes(minutes)) return minutes;
  }
  return null;
}

export function DoseTrack({ doses, disabled = false, onMove, onAdd }: {
  doses: MedicineSlot[];
  disabled?: boolean;
  onMove: (slotId: string, time: string) => Promise<void> | void;
  onAdd: (time: string) => void;
}) {
  const [width, setWidth] = useState(0);
  const times = doses.map((slot) => toMinutes(slot.alarmAt));
  const add = (event: GestureResponderEvent) => {
    if (!width || disabled || doses.length >= 24) return;
    const minutes = nearestFree((event.nativeEvent.locationX / width) * DAY, times);
    if (minutes !== null) onAdd(toClock(minutes));
  };
  return <View className="px-4 pb-1 pt-7">
    <Pressable testID="dose-track" importantForAccessibility="no" accessible={false} disabled={disabled} onPress={add} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} className="h-12 justify-center">
      <View className="h-1.5 rounded-full bg-surface-muted" />
      {HOURS.map((hour) => <View key={hour} pointerEvents="none" className="absolute h-3 w-px bg-divider" style={{ left: (hour / 24) * width }} />)}
    </Pressable>
    {width ? doses.map((slot) => <Handle key={slot.id} slot={slot} width={width} occupied={times.filter((time) => time !== toMinutes(slot.alarmAt))} disabled={disabled} onMove={onMove} />) : null}
    <View pointerEvents="none" className="h-4 flex-row" accessible={false} importantForAccessibility="no-hide-descendants">
      {HOURS.map((hour) => <Text key={hour} variant="caption" className="absolute w-10 text-center" style={{ left: (hour / 24) * width - 20, fontVariant: ['tabular-nums'] }}>{String(hour).padStart(2, '0')}</Text>)}
    </View>
  </View>;
}

function Handle({ slot, width, occupied, disabled, onMove }: {
  slot: MedicineSlot; width: number; occupied: number[]; disabled: boolean;
  onMove: (slotId: string, time: string) => Promise<void> | void;
}) {
  const minutes = toMinutes(slot.alarmAt);
  const base = (minutes / DAY) * width;
  const x = useSharedValue(base);
  const start = useSharedValue(base);
  const step = useSharedValue(minutes);
  const [dragLabel, setLabel] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const label = dragLabel ?? slot.alarmAt;
  useEffect(() => {
    x.set(withSpring(base, { duration: 300, dampingRatio: 0.8, reduceMotion: ReduceMotion.System }));
    step.set(minutes);
  }, [attempts, base, minutes, slot.alarmAt, step, x]);
  const commit = async (target: number) => {
    const free = nearestFree(target, occupied);
    if (free !== null && free !== minutes) {
      x.set(withSpring((free / DAY) * width, { duration: 300, dampingRatio: 0.8, reduceMotion: ReduceMotion.System }));
      setLabel(toClock(free));
      await Promise.resolve(onMove(slot.id, toClock(free))).catch(() => {});
    }
    setLabel(null);
    setAttempts((count) => count + 1);
  };
  const pan = Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetX([-6, 6])
    .failOffsetY([-14, 14])
    .onStart(() => { start.set(x.get()); })
    .onUpdate((event) => {
      const next = Math.min(width, Math.max(0, start.get() + event.translationX));
      x.set(next);
      step.set(Math.round((next / width) * DAY / STEP) * STEP);
    })
    .onEnd(() => { scheduleOnRN(commit, step.get()); });
  useAnimatedReaction(() => step.get(), (current, previous) => {
    if (previous !== null && current !== previous) scheduleOnRN(setLabel, toClock(Math.min(LAST, Math.max(FIRST, current))));
  });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() - HIT / 2 }] }));
  const adjust = (direction: 1 | -1) => {
    const next = nextFree(minutes, direction, occupied);
    if (next !== null && !disabled) void onMove(slot.id, toClock(next));
  };
  return <GestureDetector gesture={pan}>
    <Animated.View
      accessible accessibilityRole="adjustable" accessibilityLabel={`Dose at ${slot.alarmAt}`} accessibilityValue={{ text: slot.alarmAt }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => adjust(event.nativeEvent.actionName === 'increment' ? 1 : -1)}
      className="absolute items-center justify-center" style={[{ top: 28, left: 16, width: HIT, height: HIT }, style]}
    >
      <Text variant="caption" numberOfLines={1} className="absolute -top-5 w-16 text-center font-semibold text-foreground" style={{ fontVariant: ['tabular-nums'] }}>{label}</Text>
      <View className="items-center justify-center rounded-full border-2 border-background bg-accent" style={{ width: KNOB, height: KNOB }}>
        <Text className="text-caption font-semibold text-on-accent">{slot.amount}</Text>
      </View>
    </Animated.View>
  </GestureDetector>;
}
