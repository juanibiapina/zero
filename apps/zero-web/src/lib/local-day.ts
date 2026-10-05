import { localToday } from "@zero/agent-core";
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let observedDay = localToday();
let timer: ReturnType<typeof setTimeout> | null = null;

function refresh() {
  const day = localToday();
  if (day !== observedDay) {
    observedDay = day;
    for (const listener of listeners) listener();
  }
  if (timer !== null) clearTimeout(timer);
  if (listeners.size === 0) { timer = null; return; }
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  timer = setTimeout(refresh, Math.max(1, midnight.getTime() - now.getTime() + 1));
}

function onVisible() {
  if (document.visibilityState === "visible") refresh();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

export function useLocalDay(): string {
  return useSyncExternalStore(subscribe, localToday, localToday);
}
