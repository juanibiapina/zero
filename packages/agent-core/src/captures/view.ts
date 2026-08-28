// What the Inbox list region should show, decided once and shared by the web and
// mobile screens so the local-first rule lives in one tested place.
//
// The rule: never hide existing rows behind a spinner. The persisted collection
// hydrates the local snapshot into `data` before its network sync marks the
// collection ready, so `isLoading` stays true while rows already exist. Gating
// on the row count (not `isLoading`) paints the stale snapshot at once and lets
// the sync update it in place. The spinner shows only when there is genuinely
// nothing yet, which also stops an empty-state flash before hydration.
export type InboxView = "rows" | "loading" | "empty" | "error";

export function inboxView(state: {
  count: number;
  isLoading: boolean;
  loadError: string | null;
}): InboxView {
  if (state.count > 0) return "rows";
  if (state.isLoading) return "loading";
  if (state.loadError) return "error";
  return "empty";
}
