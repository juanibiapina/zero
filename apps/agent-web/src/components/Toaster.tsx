import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { defaultToastController, type Toast } from "@zero/agent-core";
import { cn } from "@/lib/utils";

// Web renderer adapter over the shared, headless toast controller
// (@zero/agent-core). It only paints the controller's snapshot: all queueing,
// timers and de-duplication live in the controller. Mounted once at the app
// root (see App.tsx).

// How long the close animation runs; a leaving row stays mounted this long so
// the exit transition can play after the controller drops it.
const EXIT_MS = 180;

function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    defaultToastController.subscribe,
    defaultToastController.getSnapshot,
    defaultToastController.getSnapshot,
  );
}

type Rendered = Toast & { leaving: boolean };

// Presence: keep a row mounted through its exit animation. The controller's
// snapshot is the source of truth for what's live; this holds a removed row for
// EXIT_MS with `leaving: true` so the close animation can run, then drops it.
function usePresence(live: readonly Toast[]): Rendered[] {
  const [rendered, setRendered] = useState<Rendered[]>(() =>
    live.map((t) => ({ ...t, leaving: false })),
  );
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const liveById = new Map(live.map((t) => [t.id, t]));
    setRendered((prev) => {
      const next: Rendered[] = [];
      // Live rows first, in controller order, refreshed to their live content.
      for (const t of live) next.push({ ...t, leaving: false });
      // Rows that left the controller linger as leaving until their timer fires.
      for (const p of prev) {
        if (!liveById.has(p.id)) {
          if (!next.some((n) => n.id === p.id)) next.push({ ...p, leaving: true });
          if (!timers.current.has(p.id)) {
            timers.current.set(
              p.id,
              setTimeout(() => {
                timers.current.delete(p.id);
                setRendered((r) => r.filter((x) => x.id !== p.id));
              }, EXIT_MS),
            );
          }
        } else {
          // Re-appeared before its timer fired: cancel the removal.
          const handle = timers.current.get(p.id);
          if (handle) {
            clearTimeout(handle);
            timers.current.delete(p.id);
          }
        }
      }
      return next;
    });
  }, [live]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) clearTimeout(handle);
      map.clear();
    };
  }, []);

  return rendered;
}

export function Toaster() {
  const rendered = usePresence(useToasts());
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      {rendered.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastRow({ toast }: { toast: Rendered }) {
  const state = toast.leaving ? "closed" : "open";
  return (
    <div
      data-state={state}
      className={cn(
        "pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-2",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {toast.message}
        </p>
        {toast.description ? (
          toast.descriptionAction ? (
            <button
              type="button"
              className="block max-w-full truncate text-left text-sm text-muted-foreground hover:text-foreground"
              aria-label={toast.descriptionAction.accessibilityLabel}
              onClick={() => {
                toast.descriptionAction?.onPress();
                defaultToastController.dismiss(toast.id);
              }}
            >
              {toast.description}
            </button>
          ) : (
            <p className="truncate text-sm text-muted-foreground">
              {toast.description}
            </p>
          )
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {toast.action ? (
          <button
            type="button"
            className="min-h-10 rounded-md px-2 text-sm font-semibold text-primary hover:bg-primary/10"
            onClick={() => {
              toast.action?.onPress();
              defaultToastController.dismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
        {toast.secondaryAction ? (
          <button
            type="button"
            className="min-h-10 rounded-md px-2 text-sm font-semibold text-primary hover:bg-primary/10"
            onClick={() => {
              toast.secondaryAction?.onPress();
              defaultToastController.dismiss(toast.id);
            }}
          >
            {toast.secondaryAction.label}
          </button>
        ) : null}
        {toast.link ? (
          <button
            type="button"
            className="min-h-10 rounded-md px-2 text-sm font-semibold text-primary hover:bg-primary/10"
            onClick={() => {
              toast.link?.onPress();
              defaultToastController.dismiss(toast.id);
            }}
          >
            {toast.link.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
