import { useSyncExternalStore } from 'react';

// A refine session: the capture the user is currently refining into tasks and
// projects. Module-level (a tiny observable) so it is shared across screens —
// start it from a capture on Today, then create tasks there or projects on the
// Projects tab, and everything created while it is active links back to the
// capture. "Done" consumes the capture. See
// docs/plans/todo-availability-model.md (slice 8).
export type RefineSession = { id: string; text: string };

let session: RefineSession | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function startRefine(id: string, text: string): void {
  session = { id, text };
  emit();
}

export function stopRefine(): void {
  session = null;
  emit();
}

export function refiningCaptureId(): string | null {
  return session?.id ?? null;
}

export function useRefineSession(): RefineSession | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => session,
    () => session,
  );
}
