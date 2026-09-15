import { localToday } from '@zero/agent-core';
import { useSyncExternalStore } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';

type Listener = () => void;

// One app-wide local-day source: all mounted callers share one midnight timer
// and one lifecycle listener, while useSyncExternalStore gives each caller the
// same primitive snapshot in a render.
const listeners = new Set<Listener>();
let observedDay = localToday();
let timer: ReturnType<typeof setTimeout> | null = null;
let appStateSubscription: NativeEventSubscription | null = null;

function getSnapshot(): string {
  return localToday();
}

// Construct the next local midnight rather than adding 24 hours, so a DST
// transition cannot shift the day boundary. The extra millisecond places the
// callback just after the exact boundary.
function millisecondsUntilNextLocalDay(now = new Date()): number {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  return Math.max(1, next.getTime() - now.getTime() + 1);
}

function publishDayIfChanged(): void {
  const day = getSnapshot();
  if (day === observedDay) return;
  observedDay = day;
  for (const listener of listeners) listener();
}

function scheduleNextLocalDay(): void {
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    publishDayIfChanged();
    if (listeners.size > 0) scheduleNextLocalDay();
  }, millisecondsUntilNextLocalDay());
}

function start(): void {
  observedDay = getSnapshot();
  scheduleNextLocalDay();
  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    publishDayIfChanged();
    scheduleNextLocalDay();
  });
}

function stop(): void {
  if (timer != null) clearTimeout(timer);
  timer = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function useLocalDay(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}
