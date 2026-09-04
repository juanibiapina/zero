// What an entity's list region should show, decided once and shared by every
// web and mobile screen so the local-first rule lives in one tested place.
//
// The rule: never hide existing rows behind a spinner. The persisted collection
// hydrates the local snapshot into `data` before its network sync marks the
// collection ready, so `isLoading` stays true while rows already exist. Gating
// on the row count (not `isLoading`) paints the stale snapshot at once and lets
// the sync update it in place. The spinner shows only when there is genuinely
// nothing yet, which also stops an empty-state flash before hydration.
export type ListView = "rows" | "loading" | "empty" | "error";

// How long a list may sit empty-and-loading before it shows the "Loading…" text.
// The local snapshot hydrates cached rows in well under this, so a normal load
// paints straight to the list with no spinner flash; the text only appears on a
// genuinely slow first load (empty cache waiting on the network). Shared by every
// list screen so the delay is tuned in one place.
export const LOADING_TEXT_DELAY_MS = 1000;

export function listView(state: {
  count: number;
  isLoading: boolean;
  loadError: string | null;
}): ListView {
  if (state.count > 0) return "rows";
  if (state.isLoading) return "loading";
  if (state.loadError) return "error";
  return "empty";
}
