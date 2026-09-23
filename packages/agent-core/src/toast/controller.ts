import { safeRandomUUID } from "@tanstack/db";

// A headless, framework-agnostic toast controller: the deep module behind a tiny
// interface. It owns id minting, queueing, de-duplication/replacement by id,
// auto-dismiss timers, and max-visible capping, and exposes an observable
// snapshot. It knows nothing about React, the DOM, React Native, or navigation —
// each surface renders the snapshot through its own <Toaster>. The interface is
// the test surface; behaviour is verified through show/dismiss/subscribe/
// getSnapshot with fake timers.

// A tappable action rendered alongside the message. `onPress` is the neutral
// name: the web renderer wires it to a button click, the mobile renderer to a
// Pressable press.
export type ToastAction = { label: string; accessibilityLabel?: string; onPress: () => void };
export type ToastDescriptionAction = {
  accessibilityLabel: string;
  onPress: () => void;
};

// What a caller passes to show a toast. `id` lets a caller key a toast so a
// re-show replaces it in place (and restarts its timer) instead of stacking a
// duplicate. `durationMs` of Infinity makes the toast sticky (no auto-dismiss).
// `action` is the primary affordance (e.g. Undo); `link` is an optional
// secondary, navigation-style tappable a renderer places beside it.
export type ToastInput = {
  message: string;
  description?: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
  descriptionAction?: ToastDescriptionAction;
  link?: ToastAction;
  durationMs?: number;
  id?: string;
};

// A live toast in the snapshot. `id` is stable (caller-supplied or minted);
// `createdAt` orders the queue. `action` is the primary tappable; `link` is an
// optional secondary navigation tappable.
export type Toast = {
  id: string;
  message: string;
  description?: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
  descriptionAction?: ToastDescriptionAction;
  link?: ToastAction;
  durationMs: number;
  createdAt: number;
};

export type ToastController = {
  // Show a toast; returns its id. Passing a bare string is shorthand for
  // `{ message }`. Re-showing an existing id replaces that toast in place.
  show: (input: ToastInput | string) => string;
  // Dismiss one toast by id, or all toasts when called with no id.
  dismiss: (id?: string) => void;
  // Ignore stale snapshots: an async native timeout must not alter a replacement.
  deferDismiss: (toast: Toast, durationMs: number) => void;
  // Observable seam for a renderer's useSyncExternalStore. Declared as arrow
  // properties (not methods) so callers can pass `controller.subscribe` /
  // `controller.getSnapshot` straight to useSyncExternalStore.
  subscribe: (cb: () => void) => () => void;
  // The current toasts. Returns the SAME array reference until a mutation, and a
  // fresh reference on every change — the useSyncExternalStore contract.
  getSnapshot: () => readonly Toast[];
};

export type ToastControllerOptions = {
  // Auto-dismiss delay when a toast doesn't set its own. Default 4000ms.
  defaultDurationMs?: number;
  // Most toasts retained at once; the oldest are dropped past this. Default 3.
  maxVisible?: number;
};

export function createToastController(
  options: ToastControllerOptions = {},
): ToastController {
  const defaultDurationMs = options.defaultDurationMs ?? 4000;
  const maxVisible = options.maxVisible ?? 3;

  let toasts: readonly Toast[] = [];
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function emit(): void {
    for (const l of listeners) l();
  }

  function clearTimer(id: string): void {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
  }

  function scheduleDismiss(id: string, durationMs: number): void {
    clearTimer(id);
    if (durationMs === Infinity) return;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        dismiss(id);
      }, durationMs),
    );
  }

  function dismiss(id?: string): void {
    if (id === undefined) {
      if (toasts.length === 0) return;
      for (const t of toasts) clearTimer(t.id);
      toasts = [];
      emit();
      return;
    }
    if (!toasts.some((t) => t.id === id)) return;
    clearTimer(id);
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }

  function show(input: ToastInput | string): string {
    const normalized: ToastInput =
      typeof input === "string" ? { message: input } : input;
    const id = normalized.id ?? safeRandomUUID();
    const existing = toasts.find((t) => t.id === id);
    const next: Toast = {
      id,
      message: normalized.message,
      description: normalized.description,
      action: normalized.action,
      secondaryAction: normalized.secondaryAction,
      descriptionAction: normalized.descriptionAction,
      link: normalized.link,
      durationMs: normalized.durationMs ?? defaultDurationMs,
      // Keep the original position on a replace so it doesn't jump.
      createdAt: existing?.createdAt ?? Date.now(),
    };

    if (existing) {
      toasts = toasts.map((t) => (t.id === id ? next : t));
    } else {
      // Newest last; cap the retained list by dropping the oldest.
      const appended = [...toasts, next];
      const overflow = appended.slice(0, Math.max(0, appended.length - maxVisible));
      for (const t of overflow) clearTimer(t.id);
      toasts = appended.slice(-maxVisible);
    }

    scheduleDismiss(id, normalized.durationMs ?? defaultDurationMs);
    emit();
    return id;
  }

  // Standalone closures (not object methods) so callers can pass them directly to
  // useSyncExternalStore without an unbound-`this` hazard.
  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };
  const getSnapshot = (): readonly Toast[] => toasts;

  const deferDismiss = (toast: Toast, durationMs: number): void => {
    if (toasts.includes(toast)) scheduleDismiss(toast.id, durationMs);
  };
  return { show, dismiss, deferDismiss, subscribe, getSnapshot };
}

// The module-level default controller and the ergonomic bound function, mirroring
// sonner: `toast('Saved')` or `toast('Saved', { action })`, plus `toast.dismiss`.
export const defaultToastController = createToastController();

type ToastFn = {
  (message: string, opts?: Omit<ToastInput, "message">): string;
  dismiss(id?: string): void;
};

export const toast: ToastFn = Object.assign(
  (message: string, opts?: Omit<ToastInput, "message">): string =>
    defaultToastController.show({ message, ...opts }),
  {
    dismiss(id?: string): void {
      defaultToastController.dismiss(id);
    },
  },
);
