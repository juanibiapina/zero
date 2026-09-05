// A one-shot channel for handing a project's Done/Delete from its detail screen
// back to the still-mounted Projects list underneath it in the stack. The list
// owns the ~5s undoable-leave timer (a project marked done or deleted leaves the
// working list, so the transient Undo belongs where the row is). The detail
// screen requests the leave, then pops back; the list starts the timer.
export type ProjectLeaveKind = 'done' | 'delete';
export type ProjectLeave = { id: string; kind: ProjectLeaveKind };

const handlers = new Set<(leave: ProjectLeave) => void>();

// The list registers its handler while mounted; returns an unsubscribe.
export function onProjectLeave(handler: (leave: ProjectLeave) => void): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

// The detail screen calls this before router.back(): the list (mounted beneath
// the pushed detail) starts the undoable leave synchronously.
export function requestProjectLeave(id: string, kind: ProjectLeaveKind): void {
  for (const handler of handlers) handler({ id, kind });
}
